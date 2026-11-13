//! THE SUITE EVERY GATEWAY MUST PASS (#1080).
//!
//! The protocol is the reference and this is what "conforming" means. It is a
//! library function over a [`Target`] — the routes as a phone calls them, plus
//! the few things only an operator or a test can do — so the same named cases
//! run against the in-memory rules ([`crate::rules::memory::MemoryTarget`],
//! `tests/conformance.rs`) and against the real server through the real
//! client (`tests/conformance_wire.rs`). A case that passes on one and fails on
//! the other is a bug in whichever end differs.
//!
//! # WHAT IT PROVES, AND WHAT IT CANNOT
//!
//! It proves the rules: pairing by secret, claim and read grant; tenancy and
//! the epoch fence; write-once admission; the head's compare-and-set and the
//! snapshot history; tombstones, their grace and the purge; the store
//! semantics a phone's store relies on (the `store/` cases, the root's ruling
//! A15, which the vault's `MemoryStore` models in memory); the blind scrub;
//! the bundle both ways; and the two canaries. It cannot prove three things:
//!
//! 1. **That `atomically` is atomic under concurrency.** The cases drive two
//!    phones in sequence; the SQLite adapter's `BEGIN IMMEDIATE` is what makes
//!    an interleaving impossible, and that is the adapter's own test.
//! 2. **That a phone's sealed bytes carry no plaintext.** The canary proves the
//!    gateway adds no plaintext, plaintext hash or key to what it keeps. What
//!    a phone uploads is the sealed format's, proved by its own vectors.
//! 3. **That the bytes are durable.** A crash between the store's rename and
//!    its row is the adapter's to survive, by ordering.

use std::cell::Cell;
use std::fmt::Debug;
use std::ops::Deref;

use ed25519_dalek::SigningKey;

use crate::rules::bundle::Frame;
use crate::rules::code::{Code, Refusal};
pub use crate::rules::engine::ScrubCounts;
use crate::rules::ids::{Digest, GatewayId, Name, Nonce, Secret, Signature, Token, VaultId};
use crate::rules::limits::{
    DAY_MS, GRACE_MS, LIST_LIMIT, MAX_CLOCK_AHEAD_MS, MAX_GENERATION_JUMP, MAX_LIVE_NONCES,
    MAX_LIVE_SECRETS, MAX_NAMES, MAX_OBJECT_BYTES, MAX_REVOKED_PER_VAULT, NONCE_TTL_MS, PROTOCOL,
    PURGE_GAP_INTERVALS, PURGE_INTERVAL_MS, REVOKED_TOKEN_KEEP_MS, SECRET_TTL_MS,
};
use crate::rules::range::ByteRange;
use crate::rules::signing::{
    HeadFields, sign_claim, sign_delete, sign_head, sign_pair, sign_read, sign_undo,
};
use crate::rules::wire::{
    BundleAnswer, ClaimBody, DeleteAnswer, DeleteRequest, HeadView, HeldEntry, HeldKind, Info,
    NonceAnswer, ObjectEntry, PairKind, PairRequest, Paired, ReadBody, SecretBody, SetHead,
    SnapshotView, UndoRequest, Undone,
};

/// One case's verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Case {
    pub name: &'static str,
    pub passed: bool,
    /// What happened, when it did not pass.
    pub detail: String,
}

/// Every case's verdict.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub cases: Vec<Case>,
}

impl Report {
    fn record(&mut self, name: &'static str, outcome: Result<(), String>) {
        let (passed, detail) = match outcome {
            Ok(()) => (true, String::new()),
            Err(detail) => (false, detail),
        };
        self.cases.push(Case {
            name,
            passed,
            detail,
        });
    }

    /// Did every case pass?
    #[must_use]
    pub fn is_green(&self) -> bool {
        self.cases.iter().all(|case| case.passed)
    }

    /// One line per case.
    #[must_use]
    pub fn render(&self) -> String {
        self.cases
            .iter()
            .map(|case| {
                if case.passed {
                    format!("ok    {}\n", case.name)
                } else {
                    format!("FAIL  {} — {}\n", case.name, case.detail)
                }
            })
            .collect()
    }
}

/// Why a call did not succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// The gateway refused, with this code and these companions.
    Refused(Refusal),
    /// Anything else: a store fault, a transport that broke, an answer that
    /// did not parse. No case expects one.
    Broken(String),
}

impl From<Refusal> for Failure {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

/// What a `PUT` answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PutAnswer {
    /// `201`: new bytes, now held.
    Stored(ObjectEntry),
    /// `200`: held already with this digest.
    AlreadyStored(ObjectEntry),
}

/// A gateway the suite can drive. The protocol methods are exactly the
/// routes; the operator methods are what a member at the gateway's terminal,
/// or a test, can do that no phone can.
#[expect(
    async_fn_in_trait,
    reason = "the suite drives one target on one task; neither target needs \
              its futures to be Send, and a bound nothing needs is not added"
)]
pub trait Target {
    /// Throw everything away: a gateway that has never seen a vault.
    async fn reset(&mut self) -> Result<(), String>;
    /// This gateway's id.
    fn gateway_id(&self) -> GatewayId;
    /// The operator's `pair` verb: one fresh pairing secret.
    async fn mint_secret(&mut self) -> Result<Secret, String>;
    /// Move the gateway's clock forward.
    async fn advance(&mut self, ms: i64);
    /// Run the purge sweep now; how many objects it purged.
    async fn purge(&mut self) -> Result<u64, String>;
    /// Run the scrub sweep now.
    async fn scrub(&mut self) -> Result<ScrubCounts, String>;
    /// Flip one bit of a stored object's bytes, behind the protocol's back.
    async fn corrupt(&mut self, vault: &VaultId, name: &Name) -> Result<(), String>;
    /// The operator's `freeze`.
    async fn freeze(&mut self, vault: &VaultId) -> Result<(), String>;
    /// The operator's `unfreeze`: how long the vault had been frozen.
    async fn unfreeze(&mut self, vault: &VaultId) -> Result<i64, String>;
    /// The operator's `undo`: how many holds it lifted.
    async fn operator_undo(&mut self, vault: &VaultId) -> Result<u64, String>;
    /// The epochs of every token a vault has: what a takeover leaves.
    async fn token_epochs(&mut self, vault: &VaultId) -> Result<Vec<u64>, String>;
    /// How many revoked-token tombstones a vault keeps.
    async fn revoked_count(&mut self, vault: &VaultId) -> Result<u64, String>;
    /// How many pairing secrets the gateway keeps, in any state.
    async fn secret_count(&mut self) -> Result<u64, String>;
    /// The nonce table's rows as bytes.
    async fn nonce_rows(&mut self) -> Result<Vec<Vec<u8>>, String>;
    /// **Every byte the gateway keeps at rest**, file names included: the
    /// canary's window.
    async fn at_rest(&mut self) -> Result<Vec<u8>, String>;

    async fn info(&mut self) -> Result<Info, Failure>;
    async fn pair(&mut self, request: &PairRequest) -> Result<Paired, Failure>;
    async fn head(&mut self, token: &Token, vault: &VaultId) -> Result<HeadView, Failure>;
    async fn set_head(
        &mut self,
        token: &Token,
        vault: &VaultId,
        request: &SetHead,
    ) -> Result<HeadView, Failure>;
    /// `GET snapshots`: one page, by name.
    async fn snapshots(
        &mut self,
        token: &Token,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<SnapshotView>, Failure>;
    /// `GET held`: one page, by name.
    async fn held(
        &mut self,
        token: &Token,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<HeldEntry>, Failure>;
    /// `POST nonce`.
    async fn nonce(&mut self) -> Result<NonceAnswer, Failure>;
    async fn exists(
        &mut self,
        token: &Token,
        vault: &VaultId,
        names: &[Name],
    ) -> Result<Vec<Name>, Failure>;
    async fn put(
        &mut self,
        token: &Token,
        vault: &VaultId,
        name: &Name,
        digest: &Digest,
        bytes: &[u8],
    ) -> Result<PutAnswer, Failure>;
    async fn get(
        &mut self,
        token: &Token,
        vault: &VaultId,
        name: &Name,
        range: Option<ByteRange>,
    ) -> Result<Vec<u8>, Failure>;
    /// `HEAD`: the size and digest.
    async fn stat(
        &mut self,
        token: &Token,
        vault: &VaultId,
        name: &Name,
    ) -> Result<(u64, Digest), Failure>;
    async fn bundle(
        &mut self,
        token: &Token,
        vault: &VaultId,
        frames: &[Frame],
    ) -> Result<BundleAnswer, Failure>;
    async fn fetch(
        &mut self,
        token: &Token,
        vault: &VaultId,
        names: &[Name],
    ) -> Result<Vec<Frame>, Failure>;
    async fn objects(
        &mut self,
        token: &Token,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<ObjectEntry>, Failure>;
    async fn delete(
        &mut self,
        token: &Token,
        vault: &VaultId,
        request: &DeleteRequest,
    ) -> Result<DeleteAnswer, Failure>;
    async fn undo(
        &mut self,
        token: &Token,
        vault: &VaultId,
        request: &UndoRequest,
    ) -> Result<Undone, Failure>;
    /// `POST /v3/v/{vault}/revoke`: the calling token revokes itself.
    async fn revoke(&mut self, token: &Token, vault: &VaultId) -> Result<(), Failure>;
}

/// Every case, by name, in the order [`run`] runs them. A target's test
/// asserts its report names exactly these, so a dropped case is a failure.
pub const CASES: [&str; 59] = [
    "info/answers-before-anything-is-paired",
    "pair/a-secret-admits-one-new-vault-once",
    "pair/a-known-vault-is-refused-and-the-secret-is-not-spent",
    "pair/an-expired-or-unknown-secret-is-unauthorized",
    "pair/a-malformed-pairing-is-a-bad-request",
    "auth/a-stranger-a-wrong-vault-and-an-unknown-vault-are-one-answer",
    "objects/put-is-write-once-by-name-and-digest",
    "objects/a-digest-that-is-not-the-bytes-stores-nothing",
    "objects/over-eighty-mebibytes-is-too-large",
    "objects/exists-names-what-is-missing",
    "objects/get-serves-bytes-ranges-and-a-digest",
    "objects/the-listing-is-sorted-and-pages",
    "bundle/each-frame-is-answered-as-its-own-put-would-be",
    "fetch/answers-the-bundle-framing-for-what-is-held",
    "head/moves-only-by-compare-and-set-and-registers-snapshots",
    "delete/a-tombstone-keeps-its-bytes-until-the-grace-ends",
    "delete/the-head-is-in-use-and-a-tombstone-can-be-stored-again",
    "store/exists-reads-a-tombstoned-name-as-missing",
    "store/a-put-over-a-tombstone-brings-the-name-back",
    "store/a-head-naming-a-manifest-not-held-is-not-found",
    "store/deleting-an-absent-name-succeeds",
    "store/the-listing-leaves-tombstones-out",
    "store/name-taken-is-a-conflict-carrying-the-held-digest",
    "scrub/rot-is-found-without-a-key-and-the-name-reads-missing",
    "claim/a-bad-signature-a-wrong-epoch-or-an-unknown-vault-moves-nothing",
    "read/a-read-grant-reads-and-never-writes",
    "fence/a-claim-moves-the-writer-and-the-old-phone-is-moved",
    "fence/a-stale-head-seen-moves-nothing",
    "canary/no-plaintext-plaintext-hash-or-key-is-at-rest",
    "canary/no-token-or-pairing-secret-is-at-rest",
    "auth/a-revoked-token-is-unauthorized-everywhere",
    "signed/head-needs-the-vault-signature",
    "signed/a-head-never-falls-within-an-epoch",
    "signed/generation-jumps-are-bounded",
    "signed/a-claim-may-reset-the-generation",
    "takeover/a-claim-revokes-every-older-token",
    "takeover/moved-carries-a-claim-bound-to-the-gateway",
    "takeover/revoked-token-tombstones",
    "takeover/a-claim-cancels-held-deletes",
    "delete/delete-needs-the-vault-signature",
    "delete/a-delete-is-held",
    "delete/a-delete-replay-is-refused",
    "delete/head-and-snapshot-keep-their-manifest",
    "delete/an-undo-lifts-holds",
    "pair/pair-by-secret-needs-the-vault-signature",
    "pair/pair-signature-binds-its-fields",
    "nonce/a-nonce-is-single-use",
    "nonce/a-claim-cannot-be-replayed",
    "nonce/a-nonce-expires",
    "nonce/nonces-are-bounded",
    "nonce/canary-nonce",
    "head/taken-at-is-bounded",
    "pair/secrets-are-bounded",
    "operator/a-frozen-vault-refuses-writes-and-answers-reads",
    "operator/unfreeze-gives-back-the-time-it-was-frozen",
    "operator/operator-undo-restores-every-hold",
    "operator/a-gap-between-sweeps-is-not-counted",
    "nonce/the-nonce-route-writes-nothing",
    "nonce/a-nonce-is-checked",
];

/// **The names tests.md gives, and the case each runs.** `tests/conformance.rs`
/// and `tests/conformance_wire.rs` each make one `#[test]` per row, so the
/// attacker tests are found by their names and run over the rules in memory
/// and over the wire.
pub const NAMED: &[(&str, &str)] = &[
    (
        "a_token_without_the_vault_key_cannot_set_a_head",
        "signed/head-needs-the-vault-signature",
    ),
    (
        "an_old_signed_head_replayed_is_out_of_order",
        "signed/a-head-never-falls-within-an-epoch",
    ),
    (
        "a_generation_jump_beyond_the_bound_is_refused",
        "signed/generation-jumps-are-bounded",
    ),
    (
        "a_claim_resets_the_generation_and_the_next_head_is_accepted",
        "signed/a-claim-may-reset-the-generation",
    ),
    (
        "a_head_names_a_held_manifest_only",
        "store/a-head-naming-a-manifest-not-held-is-not-found",
    ),
    (
        "a_takeover_leaves_no_live_older_token",
        "takeover/a-claim-revokes-every-older-token",
    ),
    (
        "a_moved_claim_is_bound_to_its_gateway",
        "takeover/moved-carries-a-claim-bound-to-the-gateway",
    ),
    (
        "a_revoked_token_hears_moved_until_the_tombstone_is_pruned",
        "takeover/revoked-token-tombstones",
    ),
    (
        "a_takeover_cancels_held_deletes",
        "takeover/a-claim-cancels-held-deletes",
    ),
    (
        "a_delete_needs_the_vault_signature",
        "delete/delete-needs-the-vault-signature",
    ),
    (
        "a_signed_delete_is_held_seven_days_and_stays_listed",
        "delete/a-delete-is-held",
    ),
    (
        "a_replayed_delete_is_out_of_order",
        "delete/a-delete-replay-is-refused",
    ),
    (
        "a_head_cannot_be_deleted_and_a_snapshot_row_keeps_its_object",
        "delete/head-and-snapshot-keep-their-manifest",
    ),
    ("an_undo_lifts_a_hold", "delete/an-undo-lifts-holds"),
    (
        "a_photographer_cannot_squat_the_members_vault",
        "pair/pair-by-secret-needs-the-vault-signature",
    ),
    (
        "a_pair_signature_is_bound_to_nonce_secret_and_gateway",
        "pair/pair-signature-binds-its-fields",
    ),
    (
        "a_replayed_read_grant_is_refused",
        "nonce/a-nonce-is-single-use",
    ),
    (
        "a_replayed_claim_after_a_revoke_is_refused",
        "nonce/a-claim-cannot-be-replayed",
    ),
    (
        "an_expired_nonce_is_refused_and_pruned",
        "nonce/a-nonce-expires",
    ),
    ("nonce_storage_is_bounded", "nonce/nonces-are-bounded"),
    ("the_nonce_route_names_no_vault", "nonce/canary-nonce"),
    (
        "a_head_from_the_future_is_refused",
        "head/taken-at-is-bounded",
    ),
    (
        "pairing_secrets_are_pruned_and_bounded",
        "pair/secrets-are-bounded",
    ),
    (
        "a_frozen_vault_refuses_writes_and_answers_reads",
        "operator/a-frozen-vault-refuses-writes-and-answers-reads",
    ),
    (
        "unfreeze_gives_back_the_time_it_was_frozen",
        "operator/unfreeze-gives-back-the-time-it-was-frozen",
    ),
    (
        "operator_undo_restores_every_hold",
        "operator/operator-undo-restores-every-hold",
    ),
    (
        "a_gap_between_sweeps_is_not_counted_against_a_hold",
        "operator/a-gap-between-sweeps-is-not-counted",
    ),
    (
        "the_nonce_route_writes_nothing_and_a_claim_still_works",
        "nonce/the-nonce-route-writes-nothing",
    ),
    (
        "a_forged_foreign_expired_or_replayed_nonce_is_refused",
        "nonce/a-nonce-is-checked",
    ),
];

/// Run one case by its name, or `None` for a name that is not a case.
pub async fn run_one<T: Target>(target: &mut T, case: &str) -> Option<Case> {
    let whole = run_named(target, Some(case)).await;
    whole.cases.into_iter().find(|found| found.name == case)
}

/// Run every case. The result is a [`Report`], never a panic, so one run
/// names every failure.
pub async fn run<T: Target>(target: &mut T) -> Report {
    run_named(target, None).await
}

async fn run_named<T: Target>(target: &mut T, only: Option<&str>) -> Report {
    let mut report = Report::default();
    if only.is_none_or(|case| case == CASES[0]) {
        report.record(CASES[0], info(target).await);
    }
    if only.is_none_or(|case| case == CASES[1]) {
        report.record(CASES[1], secret_admits_once(target).await);
    }
    if only.is_none_or(|case| case == CASES[2]) {
        report.record(CASES[2], known_vault(target).await);
    }
    if only.is_none_or(|case| case == CASES[3]) {
        report.record(CASES[3], dead_secret(target).await);
    }
    if only.is_none_or(|case| case == CASES[4]) {
        report.record(CASES[4], malformed_pairing(target).await);
    }
    if only.is_none_or(|case| case == CASES[5]) {
        report.record(CASES[5], tenancy(target).await);
    }
    if only.is_none_or(|case| case == CASES[6]) {
        report.record(CASES[6], write_once(target).await);
    }
    if only.is_none_or(|case| case == CASES[7]) {
        report.record(CASES[7], digest_mismatch(target).await);
    }
    if only.is_none_or(|case| case == CASES[8]) {
        report.record(CASES[8], too_large(target).await);
    }
    if only.is_none_or(|case| case == CASES[9]) {
        report.record(CASES[9], exists(target).await);
    }
    if only.is_none_or(|case| case == CASES[10]) {
        report.record(CASES[10], get(target).await);
    }
    if only.is_none_or(|case| case == CASES[11]) {
        report.record(CASES[11], listing(target).await);
    }
    if only.is_none_or(|case| case == CASES[12]) {
        report.record(CASES[12], bundle(target).await);
    }
    if only.is_none_or(|case| case == CASES[13]) {
        report.record(CASES[13], fetch(target).await);
    }
    if only.is_none_or(|case| case == CASES[14]) {
        report.record(CASES[14], head(target).await);
    }
    if only.is_none_or(|case| case == CASES[15]) {
        report.record(CASES[15], grace(target).await);
    }
    if only.is_none_or(|case| case == CASES[16]) {
        report.record(CASES[16], head_in_use(target).await);
    }
    if only.is_none_or(|case| case == CASES[17]) {
        report.record(CASES[17], exists_skips_tombstones(target).await);
    }
    if only.is_none_or(|case| case == CASES[18]) {
        report.record(CASES[18], put_revives_tombstone(target).await);
    }
    if only.is_none_or(|case| case == CASES[19]) {
        report.record(CASES[19], head_needs_held_manifest(target).await);
    }
    if only.is_none_or(|case| case == CASES[20]) {
        report.record(CASES[20], delete_absent(target).await);
    }
    if only.is_none_or(|case| case == CASES[21]) {
        report.record(CASES[21], listing_skips_tombstones(target).await);
    }
    if only.is_none_or(|case| case == CASES[22]) {
        report.record(CASES[22], name_taken(target).await);
    }
    if only.is_none_or(|case| case == CASES[23]) {
        report.record(CASES[23], scrub(target).await);
    }
    if only.is_none_or(|case| case == CASES[24]) {
        report.record(CASES[24], claim_refusals(target).await);
    }
    if only.is_none_or(|case| case == CASES[25]) {
        report.record(CASES[25], read_grant(target).await);
    }
    if only.is_none_or(|case| case == CASES[26]) {
        report.record(CASES[26], fence(target).await);
    }
    if only.is_none_or(|case| case == CASES[27]) {
        report.record(CASES[27], stale_claim(target).await);
    }
    if only.is_none_or(|case| case == CASES[28]) {
        report.record(CASES[28], blindness_canary(target).await);
    }
    if only.is_none_or(|case| case == CASES[29]) {
        report.record(CASES[29], credential_canary(target).await);
    }
    if only.is_none_or(|case| case == CASES[30]) {
        report.record(CASES[30], revoked(target).await);
    }
    if only.is_none_or(|case| case == CASES[31]) {
        report.record(CASES[31], head_needs_signature(target).await);
    }
    if only.is_none_or(|case| case == CASES[32]) {
        report.record(CASES[32], head_never_falls(target).await);
    }
    if only.is_none_or(|case| case == CASES[33]) {
        report.record(CASES[33], generation_bound(target).await);
    }
    if only.is_none_or(|case| case == CASES[34]) {
        report.record(CASES[34], claim_resets_generation(target).await);
    }
    if only.is_none_or(|case| case == CASES[35]) {
        report.record(CASES[35], claim_revokes_every_older_token(target).await);
    }
    if only.is_none_or(|case| case == CASES[36]) {
        report.record(CASES[36], moved_claim_is_bound(target).await);
    }
    if only.is_none_or(|case| case == CASES[37]) {
        report.record(CASES[37], revoked_tombstones(target).await);
    }
    if only.is_none_or(|case| case == CASES[38]) {
        report.record(CASES[38], claim_cancels_holds(target).await);
    }
    if only.is_none_or(|case| case == CASES[39]) {
        report.record(CASES[39], delete_needs_signature(target).await);
    }
    if only.is_none_or(|case| case == CASES[40]) {
        report.record(CASES[40], delete_is_held(target).await);
    }
    if only.is_none_or(|case| case == CASES[41]) {
        report.record(CASES[41], delete_replay(target).await);
    }
    if only.is_none_or(|case| case == CASES[42]) {
        report.record(CASES[42], head_and_snapshot_keep_manifest(target).await);
    }
    if only.is_none_or(|case| case == CASES[43]) {
        report.record(CASES[43], undo_lifts_holds(target).await);
    }
    if only.is_none_or(|case| case == CASES[44]) {
        report.record(CASES[44], pair_needs_signature(target).await);
    }
    if only.is_none_or(|case| case == CASES[45]) {
        report.record(CASES[45], pair_signature_binds(target).await);
    }
    if only.is_none_or(|case| case == CASES[46]) {
        report.record(CASES[46], nonce_single_use(target).await);
    }
    if only.is_none_or(|case| case == CASES[47]) {
        report.record(CASES[47], claim_not_replayable(target).await);
    }
    if only.is_none_or(|case| case == CASES[48]) {
        report.record(CASES[48], nonce_expires(target).await);
    }
    if only.is_none_or(|case| case == CASES[49]) {
        report.record(CASES[49], nonces_bounded(target).await);
    }
    if only.is_none_or(|case| case == CASES[50]) {
        report.record(CASES[50], canary_nonce(target).await);
    }
    if only.is_none_or(|case| case == CASES[51]) {
        report.record(CASES[51], taken_at_bounded(target).await);
    }
    if only.is_none_or(|case| case == CASES[52]) {
        report.record(CASES[52], secrets_bounded(target).await);
    }
    if only.is_none_or(|case| case == CASES[53]) {
        report.record(CASES[53], frozen_vault(target).await);
    }
    if only.is_none_or(|case| case == CASES[54]) {
        report.record(CASES[54], unfreeze_gives_time_back(target).await);
    }
    if only.is_none_or(|case| case == CASES[55]) {
        report.record(CASES[55], operator_undo_all(target).await);
    }
    if only.is_none_or(|case| case == CASES[56]) {
        report.record(CASES[56], gap_not_counted(target).await);
    }
    if only.is_none_or(|case| case == CASES[57]) {
        report.record(CASES[57], nonce_route_writes_nothing(target).await);
    }
    if only.is_none_or(|case| case == CASES[58]) {
        report.record(CASES[58], nonce_is_checked(target).await);
    }
    report
}

type Outcome = Result<(), String>;

// ─── fixtures ────────────────────────────────────────────────────────────────

/// A vault identity key from a seed. A test key, never a real one.
fn identity(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn vault_of(key: &SigningKey) -> VaultId {
    VaultId::from_bytes(key.verifying_key().to_bytes())
}

/// A REVOKED TOKEN IS A STRANGER (#1080, the audit's finding 2). A phone that
/// forgets a gateway revokes its own token; after that every route answers
/// it `UNAUTHORIZED`, its writes and its reads alike, and so does a second
/// revoke. Another token of the same vault keeps working, and a token cannot
/// revoke on another vault's path.
async fn revoked<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let (one, two) = (identity(1), identity(2));
    let phone = paired(target, &one).await?;
    let other = paired(target, &two).await?;
    let vault = vault_of(&one);
    let blob = object("revoked");
    store(target, &phone, &vault, &blob).await?;
    let reader = ok(
        pair_read(target, &one).await,
        "a read grant beside the phone",
    )?;
    refused(
        target.revoke(&phone.token, &vault_of(&two)).await,
        Code::Unauthorized,
        "revoking on another vault's path",
    )?;
    ok(target.revoke(&phone.token, &vault).await, "revoking itself")?;

    let late = object("after the revoke");
    refused(
        target
            .put(&phone.token, &vault, &late.0, &Digest::of(&late.1), &late.1)
            .await,
        Code::Unauthorized,
        "a revoked token's put",
    )?;
    refused(
        target.get(&phone.token, &vault, &blob.0, None).await,
        Code::Unauthorized,
        "a revoked token's get",
    )?;
    refused(
        target.head(&phone.token, &vault).await,
        Code::Unauthorized,
        "a revoked token's head",
    )?;
    refused(
        target.exists(&phone.token, &vault, &[blob.0]).await,
        Code::Unauthorized,
        "a revoked token's exists",
    )?;
    refused(
        target.fetch(&phone.token, &vault, &[blob.0]).await,
        Code::Unauthorized,
        "a revoked token's fetch",
    )?;
    refused(
        target.revoke(&phone.token, &vault).await,
        Code::Unauthorized,
        "a second revoke",
    )?;
    let held = ok(
        target.get(&reader.token, &vault, &blob.0, None).await,
        "another token of the vault reads on",
    )?;
    ensure(held == blob.1, || {
        "the other token read other bytes".to_owned()
    })?;
    ok(
        target
            .objects(&other.token, &vault_of(&two), None, 10)
            .await,
        "another vault's phone is untouched",
    )?;
    Ok(())
}

/// A stand-in for one sealed part: bytes nobody here can open, under a name
/// nobody here can compute. Distinct seeds give distinct names and bytes.
fn object(seed: &str) -> (Name, Vec<u8>) {
    let name = Name::from_bytes(blake3::derive_key(
        "centraid gateway conformance name",
        seed.as_bytes(),
    ));
    let mut bytes = vec![0_u8; 48 + seed.len()];
    let mut hasher = blake3::Hasher::new_derive_key("centraid gateway conformance bytes");
    hasher.update(seed.as_bytes());
    hasher.finalize_xof().fill(&mut bytes);
    (name, bytes)
}

/// A paired phone as the suite plays it: the token the gateway minted, the
/// vault key it signs with, and the counter every signed record advances.
struct Phone {
    paired: Paired,
    key: SigningKey,
    gateway: GatewayId,
    generation: Cell<u64>,
}

impl Deref for Phone {
    type Target = Paired;

    fn deref(&self) -> &Paired {
        &self.paired
    }
}

impl Phone {
    fn new(paired: Paired, key: &SigningKey, gateway: GatewayId) -> Self {
        Self {
            paired,
            key: key.clone(),
            gateway,
            generation: Cell::new(0),
        }
    }

    /// The generation the next signed record will carry.
    fn standing(&self) -> u64 {
        self.generation.get()
    }

    fn next(&self) -> u64 {
        self.generation.set(self.generation.get() + 1);
        self.generation.get()
    }

    /// A signed head at the next generation; `writes` follows it.
    fn head(&self, name: Name, prev: Option<Name>, taken_at_ms: i64) -> SetHead {
        self.head_at(name, prev, taken_at_ms, self.next())
    }

    fn head_at(
        &self,
        name: Name,
        prev: Option<Name>,
        taken_at_ms: i64,
        generation: u64,
    ) -> SetHead {
        self.head_gw(name, prev, taken_at_ms, generation, generation)
    }

    fn head_gw(
        &self,
        name: Name,
        prev: Option<Name>,
        taken_at_ms: i64,
        generation: u64,
        writes: u64,
    ) -> SetHead {
        let fields = HeadFields {
            epoch: self.paired.epoch,
            generation,
            writes,
            taken_at_ms,
            manifest: name,
            prev,
        };
        SetHead {
            name,
            prev,
            taken_at_ms,
            generation,
            writes,
            signature: sign_head(&self.key, &self.gateway, &fields),
        }
    }

    /// A signed delete at the next generation.
    fn delete(&self, names: &[Name]) -> DeleteRequest {
        let generation = self.next();
        DeleteRequest {
            names: names.to_vec(),
            generation,
            signature: sign_delete(
                &self.key,
                &self.gateway,
                self.paired.epoch,
                generation,
                names,
            ),
        }
    }

    /// A signed undo at the next generation.
    fn undo(&self, names: Option<&[Name]>) -> UndoRequest {
        let generation = self.next();
        UndoRequest {
            names: names.map(<[Name]>::to_vec),
            generation,
            signature: sign_undo(
                &self.key,
                &self.gateway,
                self.paired.epoch,
                generation,
                names,
            ),
        }
    }
}

/// A nonce from the gateway, as a phone asks for one before it pairs.
async fn fresh_nonce<T: Target>(target: &mut T) -> Result<Nonce, Failure> {
    Ok(target.nonce().await?.nonce)
}

/// A pairing by secret, signed by `key` with a fresh nonce, as built (not
/// yet sent).
async fn secret_request<T: Target>(
    target: &mut T,
    key: &SigningKey,
    secret: Secret,
) -> Result<PairRequest, Failure> {
    let nonce = fresh_nonce(target).await?;
    Ok(PairRequest {
        vault_id: vault_of(key),
        label: "phone".to_owned(),
        kind: PairKind::Secret,
        nonce,
        secret: Some(SecretBody {
            secret,
            signature: sign_pair(key, &target.gateway_id(), &secret, &nonce),
        }),
        claim: None,
        read: None,
    })
}

async fn claim_request<T: Target>(
    target: &mut T,
    key: &SigningKey,
    gateway: &GatewayId,
    epoch: u64,
    head_seen: Option<Name>,
) -> Result<PairRequest, Failure> {
    let nonce = fresh_nonce(target).await?;
    Ok(PairRequest {
        vault_id: vault_of(key),
        label: "restored phone".to_owned(),
        kind: PairKind::Claim,
        nonce,
        secret: None,
        claim: Some(ClaimBody {
            epoch,
            head_seen,
            signature: sign_claim(key, gateway, epoch, head_seen.as_ref(), &nonce),
        }),
        read: None,
    })
}

async fn read_request<T: Target>(
    target: &mut T,
    key: &SigningKey,
    gateway: &GatewayId,
) -> Result<PairRequest, Failure> {
    let nonce = fresh_nonce(target).await?;
    Ok(PairRequest {
        vault_id: vault_of(key),
        label: "restoring phone".to_owned(),
        kind: PairKind::Read,
        nonce,
        secret: None,
        claim: None,
        read: Some(ReadBody {
            signature: sign_read(key, gateway, &nonce),
        }),
    })
}

/// Pair by secret, the way a phone does: nonce, signature, request.
async fn pair_secret<T: Target>(
    target: &mut T,
    key: &SigningKey,
    secret: Secret,
) -> Result<Paired, Failure> {
    let request = secret_request(target, key, secret).await?;
    target.pair(&request).await
}

/// Claim `epoch` as `key`'s vault, the way a phone does.
async fn pair_claim<T: Target>(
    target: &mut T,
    key: &SigningKey,
    epoch: u64,
    head_seen: Option<Name>,
) -> Result<Paired, Failure> {
    let gateway = target.gateway_id();
    let request = claim_request(target, key, &gateway, epoch, head_seen).await?;
    target.pair(&request).await
}

/// A read grant, the way a restoring phone asks.
async fn pair_read<T: Target>(target: &mut T, key: &SigningKey) -> Result<Paired, Failure> {
    let gateway = target.gateway_id();
    let request = read_request(target, key, &gateway).await?;
    target.pair(&request).await
}

/// Every snapshot of a vault, paged by name.
async fn snapshots_all<T: Target>(
    target: &mut T,
    token: &Token,
    vault: &VaultId,
) -> Result<Vec<SnapshotView>, Failure> {
    let mut out: Vec<SnapshotView> = Vec::new();
    loop {
        let after = out.last().map(|last| last.name);
        let page = target
            .snapshots(token, vault, after.as_ref(), LIST_LIMIT)
            .await?;
        let done = page.len() < LIST_LIMIT;
        out.extend(page);
        if done {
            out.sort_by_key(|snapshot| (snapshot.taken_at_ms, snapshot.name));
            return Ok(out);
        }
    }
}

/// Pair `key`'s vault with a fresh secret.
async fn paired<T: Target>(target: &mut T, key: &SigningKey) -> Result<Phone, String> {
    let secret = target.mint_secret().await?;
    let gateway = target.gateway_id();
    let paired = ok(
        pair_secret(target, key, secret).await,
        "pairing with a fresh secret",
    )?;
    Ok(Phone::new(paired, key, gateway))
}

/// Store one object, expecting new bytes.
async fn store<T: Target>(
    target: &mut T,
    phone: &Paired,
    vault: &VaultId,
    (name, bytes): &(Name, Vec<u8>),
) -> Outcome {
    match ok(
        target
            .put(&phone.token, vault, name, &Digest::of(bytes), bytes)
            .await,
        "storing an object",
    )? {
        PutAnswer::Stored(entry) => ensure(
            entry.name == *name && entry.digest == Digest::of(bytes),
            || format!("stored {entry:?} for {name}"),
        ),
        other @ PutAnswer::AlreadyStored(_) => Err(format!("a new object answered {other:?}")),
    }
}

fn ok<T>(answer: Result<T, Failure>, what: &str) -> Result<T, String> {
    answer.map_err(|failure| format!("{what}: {failure:?}"))
}

fn refused<T: Debug>(
    answer: Result<T, Failure>,
    code: Code,
    what: &str,
) -> Result<Refusal, String> {
    match answer {
        Err(Failure::Refused(refusal)) if refusal.code() == code => Ok(refusal),
        other => Err(format!("{what}: expected {code}, got {other:?}")),
    }
}

fn ensure(held: bool, detail: impl FnOnce() -> String) -> Outcome {
    if held { Ok(()) } else { Err(detail()) }
}

/// 32 bytes that are not an Ed25519 public key.
fn not_a_key() -> VaultId {
    (0_u8..=255)
        .map(|first| {
            let mut bytes = [0_u8; 32];
            bytes[0] = first;
            VaultId::from_bytes(bytes)
        })
        .find(|vault| vault.verifying_key().is_none())
        .unwrap_or_else(|| VaultId::from_bytes([0xff; 32]))
}

/// Let the gateway watch `ms` of its clock: the clock moves an hour at a time
/// and the sweep runs after each, as a running gateway's does. A hold counts
/// only the time a sweep was there to see (#1191, R1), so a test that means
/// "a week passed" lets the gateway watch it. Answers how many objects the
/// sweeps purged, in all.
async fn watch<T: Target>(target: &mut T, ms: i64) -> Result<u64, String> {
    let mut purged = 0;
    let mut left = ms;
    while left > 0 {
        let step = left.min(PURGE_INTERVAL_MS);
        target.advance(step).await;
        purged += target.purge().await?;
        left -= step;
    }
    Ok(purged)
}

// ─── cases ───────────────────────────────────────────────────────────────────

async fn info<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let info = ok(target.info().await, "info")?;
    ensure(
        info.protocol == PROTOCOL && info.gateway_id == target.gateway_id(),
        || format!("{info:?}"),
    )
}

async fn secret_admits_once<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let secret = target.mint_secret().await?;
    let first = ok(pair_secret(target, &key, secret).await, "first use")?;
    ensure(
        first.epoch == 1 && first.gateway_id == target.gateway_id(),
        || format!("a secret pairing answered {first:?}"),
    )?;
    refused(
        pair_secret(target, &identity(2), secret).await,
        Code::Unauthorized,
        "a spent secret, for another vault",
    )?;
    let no_head = refused(
        target.head(&first.token, &vault_of(&key)).await,
        Code::NoHead,
        "the new vault's head",
    )?;
    ensure(
        no_head
            == Refusal::NoHead {
                epoch: 1,
                claim: None,
            },
        || format!("NO_HEAD must carry the writer epoch: {no_head:?}"),
    )
}

async fn known_vault<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    paired(target, &key).await?;
    let secret = target.mint_secret().await?;
    refused(
        pair_secret(target, &key, secret).await,
        Code::VaultKnown,
        "a secret for a vault already paired",
    )?;
    let other = ok(
        pair_secret(target, &identity(2), secret).await,
        "the refused secret, for a new vault",
    )?;
    ensure(other.epoch == 1, || format!("{other:?}"))
}

async fn dead_secret<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let secret = target.mint_secret().await?;
    target.advance(SECRET_TTL_MS).await;
    refused(
        pair_secret(target, &identity(1), secret).await,
        Code::Unauthorized,
        "a secret a day old",
    )?;
    refused(
        pair_secret(target, &identity(1), Secret::from_bytes([0x77; 16])).await,
        Code::Unauthorized,
        "a secret nobody minted",
    )?;
    Ok(())
}

async fn malformed_pairing<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let secret = target.mint_secret().await?;
    let good = ok(secret_request(target, &key, secret).await, "a request")?;
    let reading = ok(
        read_request(target, &key, &target.gateway_id()).await,
        "a read",
    )?;
    let cases = [
        (
            "a vault id that is not a key",
            PairRequest {
                vault_id: not_a_key(),
                ..good.clone()
            },
        ),
        (
            "a secret pairing with no secret",
            PairRequest {
                secret: None,
                ..good.clone()
            },
        ),
        (
            "a secret pairing that also carries a read grant",
            PairRequest {
                read: reading.read,
                ..good.clone()
            },
        ),
        (
            "a label with a control character",
            PairRequest {
                label: "phone\u{7}".to_owned(),
                ..good.clone()
            },
        ),
        (
            "a label longer than the limit",
            PairRequest {
                label: "x".repeat(crate::rules::limits::MAX_LABEL_BYTES + 1),
                ..good.clone()
            },
        ),
    ];
    for (what, request) in cases {
        refused(target.pair(&request).await, Code::BadRequest, what)?;
    }
    // None of those spent the secret or the nonce.
    ok(
        target.pair(&good).await,
        "the good request after the bad ones",
    )?;
    Ok(())
}

async fn tenancy<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let (one, two) = (identity(1), identity(2));
    let first = paired(target, &one).await?;
    paired(target, &two).await?;
    let blob = object("tenancy");
    let cases = [
        (
            "a token on another vault's path",
            first.token,
            vault_of(&two),
        ),
        (
            "a token nobody minted",
            Token::from_bytes([0x55; 32]),
            vault_of(&one),
        ),
        ("a vault nobody paired", first.token, vault_of(&identity(9))),
    ];
    for (what, token, vault) in cases {
        refused(target.head(&token, &vault).await, Code::Unauthorized, what)?;
        refused(
            target
                .put(&token, &vault, &blob.0, &Digest::of(&blob.1), &blob.1)
                .await,
            Code::Unauthorized,
            what,
        )?;
        refused(
            target.objects(&token, &vault, None, 10).await,
            Code::Unauthorized,
            what,
        )?;
    }
    Ok(())
}

async fn write_once<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let first = object("write once");
    store(target, &phone, &vault, &first).await?;
    let again = ok(
        target
            .put(
                &phone.token,
                &vault,
                &first.0,
                &Digest::of(&first.1),
                &first.1,
            )
            .await,
        "the same bytes again",
    )?;
    ensure(matches!(again, PutAnswer::AlreadyStored(_)), || {
        format!("a repeat answered {again:?}")
    })?;
    let other = object("other bytes").1;
    let taken = refused(
        target
            .put(&phone.token, &vault, &first.0, &Digest::of(&other), &other)
            .await,
        Code::NameTaken,
        "other bytes under a held name",
    )?;
    ensure(
        taken
            == Refusal::NameTaken {
                digest: Digest::of(&first.1),
            },
        || format!("NAME_TAKEN must carry the held digest: {taken:?}"),
    )?;
    let held = ok(
        target.get(&phone.token, &vault, &first.0, None).await,
        "reading it back",
    )?;
    ensure(held == first.1, || "the held bytes changed".to_owned())
}

async fn digest_mismatch<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let (name, bytes) = object("mismatch");
    let mismatch = refused(
        target
            .put(
                &phone.token,
                &vault,
                &name,
                &Digest::of(b"other bytes"),
                &bytes,
            )
            .await,
        Code::DigestMismatch,
        "a digest that is not the bytes",
    )?;
    ensure(
        mismatch
            == Refusal::DigestMismatch {
                computed: Digest::of(&bytes),
            },
        || format!("DIGEST_MISMATCH must carry what the bytes hash to: {mismatch:?}"),
    )?;
    let missing = ok(target.exists(&phone.token, &vault, &[name]).await, "exists")?;
    ensure(missing == vec![name], || {
        format!("a refused object was held: {missing:?}")
    })
}

async fn too_large<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let name = object("too large").0;
    let big = vec![0_u8; usize::try_from(MAX_OBJECT_BYTES).unwrap_or(usize::MAX) + 1];
    let refusal = refused(
        target
            .put(&phone.token, &vault, &name, &Digest::of(&big), &big)
            .await,
        Code::TooLarge,
        "a part one byte over the cap",
    )?;
    ensure(
        refusal
            == Refusal::TooLarge {
                limit: MAX_OBJECT_BYTES,
            },
        || format!("{refusal:?}"),
    )?;
    let missing = ok(target.exists(&phone.token, &vault, &[name]).await, "exists")?;
    ensure(missing == vec![name], || {
        "an oversized part was held".to_owned()
    })
}

async fn exists<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let held = object("held");
    let absent = object("absent").0;
    store(target, &phone, &vault, &held).await?;
    let missing = ok(
        target
            .exists(&phone.token, &vault, &[held.0, absent, held.0, absent])
            .await,
        "exists",
    )?;
    ensure(missing == vec![absent], || format!("missing {missing:?}"))?;
    let too_many: Vec<Name> = (0..=MAX_NAMES)
        .map(|index| object(&format!("many {index}")).0)
        .collect();
    let refusal = refused(
        target.exists(&phone.token, &vault, &too_many).await,
        Code::TooMany,
        "one name over the limit",
    )?;
    ensure(
        refusal
            == Refusal::TooMany {
                limit: MAX_NAMES as u64,
            },
        || format!("{refusal:?}"),
    )
}

async fn get<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let (name, bytes) = object("ranges");
    store(target, &phone, &vault, &(name, bytes.clone())).await?;
    let whole = ok(target.get(&phone.token, &vault, &name, None).await, "whole")?;
    ensure(whole == bytes, || "the whole object differs".to_owned())?;
    let middle = ok(
        target
            .get(
                &phone.token,
                &vault,
                &name,
                Some(ByteRange {
                    first: 2,
                    last: Some(5),
                }),
            )
            .await,
        "bytes 2-5",
    )?;
    ensure(middle == bytes[2..=5], || {
        format!("bytes 2-5 were {middle:?}")
    })?;
    let tail = ok(
        target
            .get(
                &phone.token,
                &vault,
                &name,
                Some(ByteRange {
                    first: 7,
                    last: None,
                }),
            )
            .await,
        "bytes 7-",
    )?;
    ensure(tail == bytes[7..], || "the tail differs".to_owned())?;
    let size = bytes.len() as u64;
    let stat = ok(target.stat(&phone.token, &vault, &name).await, "head")?;
    ensure(stat == (size, Digest::of(&bytes)), || {
        format!("head {stat:?}")
    })?;
    let past = refused(
        target
            .get(
                &phone.token,
                &vault,
                &name,
                Some(ByteRange {
                    first: size,
                    last: None,
                }),
            )
            .await,
        Code::BadRange,
        "a range past the end",
    )?;
    ensure(past == Refusal::BadRange { size }, || format!("{past:?}"))?;
    let absent = object("absent").0;
    let not_found = refused(
        target.get(&phone.token, &vault, &absent, None).await,
        Code::NotFound,
        "an object nobody stored",
    )?;
    ensure(
        not_found == Refusal::NotFound { name: Some(absent) },
        || format!("{not_found:?}"),
    )?;
    refused(
        target.stat(&phone.token, &vault, &absent).await,
        Code::NotFound,
        "the head of an object nobody stored",
    )?;
    Ok(())
}

async fn listing<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let mut stored = Vec::new();
    for index in 0..5 {
        let object = object(&format!("listed {index}"));
        store(target, &phone, &vault, &object).await?;
        stored.push(object);
    }
    let mut names: Vec<Name> = stored.iter().map(|(name, _)| *name).collect();
    names.sort();
    let mut seen = Vec::new();
    let mut after = None;
    loop {
        let page = ok(
            target
                .objects(&phone.token, &vault, after.as_ref(), 2)
                .await,
            "a page",
        )?;
        ensure(page.len() <= 2, || {
            format!("a page of {} for a limit of 2", page.len())
        })?;
        let Some(last) = page.last() else { break };
        after = Some(last.name);
        for entry in &page {
            let (_, bytes) = stored
                .iter()
                .find(|(name, _)| *name == entry.name)
                .ok_or_else(|| format!("listed {} which nobody stored", entry.name))?;
            ensure(
                entry.size == bytes.len() as u64 && entry.digest == Digest::of(bytes),
                || format!("{entry:?}"),
            )?;
        }
        seen.extend(page.iter().map(|entry| entry.name));
    }
    ensure(seen == names, || {
        format!("paged {seen:?}, expected every name sorted {names:?}")
    })
}

async fn bundle<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let taken = object("taken");
    store(target, &phone, &vault, &taken).await?;
    let good = object("good");
    let lying = object("lying");
    let frames = vec![
        Frame::of(good.0, good.1.clone()),
        Frame {
            name: lying.0,
            digest: Digest::of(b"not these bytes"),
            bytes: lying.1.clone(),
        },
        Frame::of(taken.0, object("other").1),
        Frame::of(taken.0, taken.1.clone()),
    ];
    let answer = ok(target.bundle(&phone.token, &vault, &frames).await, "bundle")?;
    ensure(answer.stored == vec![good.0], || {
        format!(
            "only new bytes are stored, as a PUT's 201: {:?}",
            answer.stored
        )
    })?;
    ensure(answer.already == vec![taken.0], || {
        format!(
            "held bytes are already, as a PUT's 200: {:?}",
            answer.already
        )
    })?;
    let refused_codes: Vec<(Name, Code)> = answer
        .refused
        .iter()
        .map(|refusal| (refusal.name, refusal.code))
        .collect();
    ensure(
        refused_codes == vec![(lying.0, Code::DigestMismatch), (taken.0, Code::NameTaken)],
        || format!("refused {refused_codes:?}"),
    )?;
    ensure(
        answer.acknowledged() == vec![good.0, taken.0, taken.0],
        || format!("acknowledged {:?}", answer.acknowledged()),
    )?;
    let back = ok(target.get(&phone.token, &vault, &good.0, None).await, "get")?;
    ensure(back == good.1, || {
        "a bundled object reads back different".to_owned()
    })
}

async fn fetch<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let one = object("fetched one");
    let two = object("fetched two");
    store(target, &phone, &vault, &one).await?;
    store(target, &phone, &vault, &two).await?;
    let absent = object("absent").0;
    let frames = ok(
        target
            .fetch(&phone.token, &vault, &[two.0, absent, one.0, two.0])
            .await,
        "fetch",
    )?;
    ensure(
        frames
            == vec![
                Frame::of(two.0, two.1.clone()),
                Frame::of(one.0, one.1.clone()),
            ],
        || format!("fetched {frames:?}"),
    )?;
    let too_many: Vec<Name> = (0..=MAX_NAMES)
        .map(|index| object(&format!("many {index}")).0)
        .collect();
    refused(
        target.fetch(&phone.token, &vault, &too_many).await,
        Code::TooMany,
        "one name over the limit",
    )?;
    Ok(())
}

async fn head<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let (first, second) = (object("manifest one"), object("manifest two"));
    store(target, &phone, &vault, &first).await?;
    store(target, &phone, &vault, &second).await?;
    let one = ok(
        target
            .set_head(&phone.token, &vault, &phone.head(first.0, None, 100))
            .await,
        "the first head",
    )?;
    ensure(
        one.name == first.0 && one.epoch == 1 && one.taken_at_ms == 100 && one.claim.is_none(),
        || format!("{one:?}"),
    )?;
    let conflict = refused(
        target
            .set_head(&phone.token, &vault, &phone.head(second.0, None, 200))
            .await,
        Code::HeadConflict,
        "a writer that never saw the head",
    )?;
    ensure(
        conflict
            == Refusal::HeadConflict {
                epoch: 1,
                head: Some(Box::new(one)),
            },
        || format!("HEAD_CONFLICT must carry the head as it stands: {conflict:?}"),
    )?;
    let request = phone.head(second.0, Some(first.0), 200);
    let two = ok(
        target.set_head(&phone.token, &vault, &request).await,
        "the second head",
    )?;
    let retried = ok(
        target.set_head(&phone.token, &vault, &request).await,
        "the second head, retried after a lost answer",
    )?;
    ensure(retried == two, || format!("{retried:?} != {two:?}"))?;
    let unheld = object("never uploaded").0;
    refused(
        target
            .set_head(
                &phone.token,
                &vault,
                &phone.head(unheld, Some(second.0), 300),
            )
            .await,
        Code::NotFound,
        "a head naming a manifest the gateway does not hold",
    )?;
    let now = ok(target.head(&phone.token, &vault).await, "the head")?;
    ensure(now == two, || format!("{now:?}"))?;
    let snapshots = ok(
        snapshots_all(target, &phone.token, &vault).await,
        "snapshots",
    )?;
    let registered: Vec<(Name, i64)> = snapshots
        .iter()
        .map(|snapshot| (snapshot.name, snapshot.taken_at_ms))
        .collect();
    ensure(registered == vec![(first.0, 100), (second.0, 200)], || {
        format!("snapshots {snapshots:?}")
    })
}

async fn grace<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let (old, new) = (object("old manifest"), object("new manifest"));
    store(target, &phone, &vault, &old).await?;
    store(target, &phone, &vault, &new).await?;
    for (name, prev) in [(old.0, None), (new.0, Some(old.0))] {
        ok(
            target
                .set_head(&phone.token, &vault, &phone.head(name, prev, 1))
                .await,
            "a head",
        )?;
    }
    let absent = object("absent").0;
    let answer = ok(
        target
            .delete(&phone.token, &vault, &phone.delete(&[old.0, absent]))
            .await,
        "delete",
    )?;
    ensure(
        answer.deleted == vec![old.0, absent] && answer.refused.is_empty(),
        || format!("{answer:?}"),
    )?;
    let snapshots = ok(
        snapshots_all(target, &phone.token, &vault).await,
        "snapshots",
    )?;
    ensure(
        snapshots
            .iter()
            .map(|snapshot| (snapshot.name, snapshot.held_at_ms.is_some()))
            .collect::<Vec<_>>()
            == vec![(old.0, true), (new.0, false)]
            || snapshots
                .iter()
                .map(|snapshot| (snapshot.name, snapshot.held_at_ms.is_some()))
                .collect::<Vec<_>>()
                == vec![(new.0, false), (old.0, true)],
        || format!("a held manifest stays registered, marked held: {snapshots:?}"),
    )?;
    let missing = ok(
        target.exists(&phone.token, &vault, &[old.0]).await,
        "exists",
    )?;
    ensure(missing == vec![old.0], || {
        "a tombstone reads as held".to_owned()
    })?;
    let listed = ok(target.objects(&phone.token, &vault, None, 10).await, "list")?;
    ensure(listed.iter().all(|entry| entry.name != old.0), || {
        "a tombstone is listed".to_owned()
    })?;
    let during = ok(target.get(&phone.token, &vault, &old.0, None).await, "get")?;
    ensure(during == old.1, || {
        "the grace must keep the bytes".to_owned()
    })?;
    let again = ok(
        target
            .delete(&phone.token, &vault, &phone.delete(&[old.0]))
            .await,
        "again",
    )?;
    ensure(again.deleted == vec![old.0], || format!("{again:?}"))?;
    let early = target.purge().await?;
    ensure(early == 0, || format!("purged {early} inside the grace"))?;
    let late = watch(target, GRACE_MS).await?;
    ensure(late == 1, || format!("purged {late} after the grace"))?;
    refused(
        target.get(&phone.token, &vault, &old.0, None).await,
        Code::NotFound,
        "a purged object",
    )?;
    Ok(())
}

async fn head_in_use<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let manifest = object("the head");
    store(target, &phone, &vault, &manifest).await?;
    ok(
        target
            .set_head(&phone.token, &vault, &phone.head(manifest.0, None, 1))
            .await,
        "the head",
    )?;
    let answer = ok(
        target
            .delete(&phone.token, &vault, &phone.delete(&[manifest.0]))
            .await,
        "delete",
    )?;
    ensure(
        answer.deleted.is_empty()
            && answer.refused.len() == 1
            && answer.refused[0].code == Code::HeadInUse,
        || format!("{answer:?}"),
    )?;
    let range = object("a range");
    store(target, &phone, &vault, &range).await?;
    ok(
        target
            .delete(&phone.token, &vault, &phone.delete(&[range.0]))
            .await,
        "delete",
    )?;
    let resealed = object("the same range, sealed again").1;
    let stored = ok(
        target
            .put(
                &phone.token,
                &vault,
                &range.0,
                &Digest::of(&resealed),
                &resealed,
            )
            .await,
        "storing a tombstoned name again",
    )?;
    ensure(matches!(stored, PutAnswer::Stored(_)), || {
        format!("{stored:?}")
    })?;
    let missing = ok(
        target.exists(&phone.token, &vault, &[range.0]).await,
        "exists",
    )?;
    ensure(missing.is_empty(), || {
        "a stored-again name is missing".to_owned()
    })
}

/// Hold `names` for deletion and expect every one deleted.
async fn tombstone<T: Target>(
    target: &mut T,
    phone: &Phone,
    vault: &VaultId,
    names: &[Name],
) -> Outcome {
    let answer = ok(
        target
            .delete(&phone.token, vault, &phone.delete(names))
            .await,
        "delete",
    )?;
    ensure(answer.deleted == names && answer.refused.is_empty(), || {
        format!("deleting {names:?} answered {answer:?}")
    })
}

async fn exists_skips_tombstones<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let (kept, dropped) = (object("kept"), object("dropped"));
    store(target, &phone, &vault, &kept).await?;
    store(target, &phone, &vault, &dropped).await?;
    tombstone(target, &phone, &vault, &[dropped.0]).await?;
    let missing = ok(
        target
            .exists(&phone.token, &vault, &[kept.0, dropped.0])
            .await,
        "exists",
    )?;
    ensure(missing == vec![dropped.0], || {
        format!("a tombstoned name must read as missing, so the phone sends it again: {missing:?}")
    })
}

async fn put_revives_tombstone<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let part = object("purged in grace, then sent again");
    store(target, &phone, &vault, &part).await?;
    tombstone(target, &phone, &vault, &[part.0]).await?;
    let resealed = object("the same part, sealed again").1;
    let answer = ok(
        target
            .put(
                &phone.token,
                &vault,
                &part.0,
                &Digest::of(&resealed),
                &resealed,
            )
            .await,
        "storing the tombstoned name again",
    )?;
    ensure(
        matches!(answer, PutAnswer::Stored(entry) if entry.digest == Digest::of(&resealed)),
        || format!("a PUT over a tombstone must store the new bytes: {answer:?}"),
    )?;
    let missing = ok(
        target.exists(&phone.token, &vault, &[part.0]).await,
        "exists",
    )?;
    ensure(missing.is_empty(), || {
        "a name stored again reads as missing".to_owned()
    })?;
    let listed = ok(target.objects(&phone.token, &vault, None, 10).await, "list")?;
    ensure(
        listed.iter().map(|entry| entry.name).collect::<Vec<_>>() == vec![part.0],
        || format!("a name stored again must be listed: {listed:?}"),
    )?;
    // The tombstone is gone, not shadowed: the purge after its grace leaves
    // the new bytes alone.
    let purged = watch(target, GRACE_MS).await?;
    ensure(purged == 0, || {
        format!("the purge took {purged} object(s) a PUT had brought back")
    })?;
    let back = ok(
        target.get(&phone.token, &vault, &part.0, None).await,
        "reading it back after the grace",
    )?;
    ensure(back == resealed, || {
        "the bytes a PUT brought back changed".to_owned()
    })
}

async fn head_needs_held_manifest<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let (first, dropped) = (object("a manifest"), object("a dropped manifest"));
    store(target, &phone, &vault, &first).await?;
    store(target, &phone, &vault, &dropped).await?;
    let head = ok(
        target
            .set_head(&phone.token, &vault, &phone.head(first.0, None, 1))
            .await,
        "the head",
    )?;
    tombstone(target, &phone, &vault, &[dropped.0]).await?;
    for (name, what) in [
        (object("never uploaded").0, "a manifest never uploaded"),
        (dropped.0, "a tombstoned manifest"),
    ] {
        let refusal = refused(
            target
                .set_head(&phone.token, &vault, &phone.head(name, Some(first.0), 2))
                .await,
            Code::NotFound,
            what,
        )?;
        ensure(refusal == Refusal::NotFound { name: Some(name) }, || {
            format!("NOT_FOUND must name the manifest: {refusal:?}")
        })?;
    }
    let now = ok(target.head(&phone.token, &vault).await, "the head")?;
    ensure(now == head, || format!("a refused head moved it: {now:?}"))
}

async fn delete_absent<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let never = object("never stored").0;
    tombstone(target, &phone, &vault, &[never]).await?;
    let purged = object("stored, deleted and purged");
    store(target, &phone, &vault, &purged).await?;
    tombstone(target, &phone, &vault, &[purged.0]).await?;
    tombstone(target, &phone, &vault, &[purged.0]).await?;
    let swept = watch(target, GRACE_MS).await?;
    ensure(swept == 1, || format!("purged {swept}"))?;
    // A phone retrying a delete whose answer it lost: never refused.
    tombstone(target, &phone, &vault, &[purged.0, never]).await
}

async fn listing_skips_tombstones<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let mut stored: Vec<(Name, Vec<u8>)> = (0..4)
        .map(|index| object(&format!("listed or not {index}")))
        .collect();
    stored.sort_by_key(|(name, _)| *name);
    for part in &stored {
        store(target, &phone, &vault, part).await?;
    }
    // Drop the second in name order, so a page boundary falls on it.
    tombstone(target, &phone, &vault, &[stored[1].0]).await?;
    let mut seen = Vec::new();
    let mut after = None;
    loop {
        let page = ok(
            target
                .objects(&phone.token, &vault, after.as_ref(), 1)
                .await,
            "a page",
        )?;
        let Some(last) = page.last() else { break };
        after = Some(last.name);
        seen.extend(page.iter().map(|entry| entry.name));
    }
    let expected = vec![stored[0].0, stored[2].0, stored[3].0];
    ensure(seen == expected, || {
        format!("the listing must leave tombstones out: {seen:?}, expected {expected:?}")
    })
}

async fn name_taken<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let held = object("sealed once");
    store(target, &phone, &vault, &held).await?;
    let resealed = object("sealed twice").1;
    let refusal = refused(
        target
            .put(
                &phone.token,
                &vault,
                &held.0,
                &Digest::of(&resealed),
                &resealed,
            )
            .await,
        Code::NameTaken,
        "the same name under another digest",
    )?;
    ensure(
        refusal
            == Refusal::NameTaken {
                digest: Digest::of(&held.1),
            },
        || format!("NAME_TAKEN must carry the held digest: {refusal:?}"),
    )?;
    ensure(Code::NameTaken.status() == 409, || {
        format!("NAME_TAKEN is a {}", Code::NameTaken.status())
    })?;
    let answer = ok(
        target
            .bundle(&phone.token, &vault, &[Frame::of(held.0, resealed.clone())])
            .await,
        "the same name under another digest, bundled",
    )?;
    ensure(
        answer.acknowledged() == vec![held.0]
            && answer.refused.len() == 1
            && answer.refused[0].code == Code::NameTaken,
        || format!("a bundled NAME_TAKEN is refused and acknowledged: {answer:?}"),
    )?;
    let back = ok(target.get(&phone.token, &vault, &held.0, None).await, "get")?;
    ensure(back == held.1, || {
        "NAME_TAKEN must leave the held bytes alone".to_owned()
    })
}

async fn scrub<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let (rotting, sound) = (object("rotting"), object("sound"));
    store(target, &phone, &vault, &rotting).await?;
    store(target, &phone, &vault, &sound).await?;
    let clean = target.scrub().await?;
    ensure(
        clean
            == ScrubCounts {
                read: 2,
                corrupt: 0,
                missing: 0,
            },
        || format!("a fresh store scrubbed {clean:?}"),
    )?;
    target.corrupt(&vault, &rotting.0).await?;
    let dirty = target.scrub().await?;
    ensure(dirty.corrupt == 1 && dirty.missing == 0, || {
        format!("a flipped bit scrubbed {dirty:?}")
    })?;
    let missing = ok(
        target
            .exists(&phone.token, &vault, &[rotting.0, sound.0])
            .await,
        "exists",
    )?;
    ensure(missing == vec![rotting.0], || {
        format!("a rotten object must read as missing so the phone resends it: {missing:?}")
    })?;
    refused(
        target.get(&phone.token, &vault, &rotting.0, None).await,
        Code::NotFound,
        "reading a rotten object",
    )?;
    let fetched = ok(
        target
            .fetch(&phone.token, &vault, &[rotting.0, sound.0])
            .await,
        "fetching around a rotten object",
    )?;
    ensure(fetched == vec![Frame::of(sound.0, sound.1.clone())], || {
        format!("a fetch must leave a rotten object out, not fail on it: {fetched:?}")
    })?;
    let resealed = object("rotting, sealed again").1;
    ok(
        target
            .put(
                &phone.token,
                &vault,
                &rotting.0,
                &Digest::of(&resealed),
                &resealed,
            )
            .await,
        "replacing a rotten object",
    )?;
    let healed = target.scrub().await?;
    ensure(healed.corrupt == 0, || {
        format!("after the resend {healed:?}")
    })
}

async fn claim_refusals<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let gateway = target.gateway_id();
    let mut forged = ok(
        claim_request(target, &key, &gateway, 2, None).await,
        "a claim",
    )?;
    if let Some(claim) = forged.claim.as_mut() {
        claim.signature = sign_claim(&identity(9), &gateway, 2, None, &forged.nonce);
    }
    refused(
        target.pair(&forged).await,
        Code::Unauthorized,
        "a claim signed by another key",
    )?;
    let elsewhere = ok(
        claim_request(target, &key, &GatewayId::from_bytes([0xee; 16]), 2, None).await,
        "a claim",
    )?;
    refused(
        target.pair(&elsewhere).await,
        Code::Unauthorized,
        "a claim signed for another gateway",
    )?;
    let skipped = refused(
        pair_claim(target, &key, 3, None).await,
        Code::EpochConflict,
        "a claim two epochs ahead",
    )?;
    ensure(
        skipped
            == Refusal::EpochConflict {
                epoch: 1,
                head: None,
            },
        || format!("EPOCH_CONFLICT must carry the epoch and the head: {skipped:?}"),
    )?;
    refused(
        pair_claim(target, &identity(5), 2, None).await,
        Code::Unauthorized,
        "a claim for a vault this gateway never paired",
    )?;
    // Nothing moved: the first phone still writes.
    store(target, &phone, &vault, &object("still writing")).await
}

async fn read_grant<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let gateway = target.gateway_id();
    let manifest = object("read manifest");
    store(target, &phone, &vault, &manifest).await?;
    ok(
        target
            .set_head(&phone.token, &vault, &phone.head(manifest.0, None, 5))
            .await,
        "the head",
    )?;
    let mut forged = ok(read_request(target, &key, &gateway).await, "a read")?;
    forged.read = Some(ReadBody {
        signature: sign_read(&identity(9), &gateway, &forged.nonce),
    });
    refused(
        target.pair(&forged).await,
        Code::Unauthorized,
        "a read grant by another key",
    )?;
    let reader = ok(pair_read(target, &key).await, "a read grant")?;
    ensure(reader.epoch == 0, || {
        format!("a read grant is epoch 0: {reader:?}")
    })?;
    let seen = ok(target.head(&reader.token, &vault).await, "reading the head")?;
    ensure(
        seen.name == manifest.0 && seen.epoch == 1 && seen.claim.is_none(),
        || format!("{seen:?}"),
    )?;
    let bytes = ok(
        target.get(&reader.token, &vault, &manifest.0, None).await,
        "reading the manifest",
    )?;
    ensure(bytes == manifest.1, || "the manifest differs".to_owned())?;
    let blob = object("a write");
    let reading = Phone::new(reader, &key, gateway);
    // A read token was never a writer: it is a stranger to every write.
    refused(
        target
            .put(
                &reading.token,
                &vault,
                &blob.0,
                &Digest::of(&blob.1),
                &blob.1,
            )
            .await,
        Code::Unauthorized,
        "a read token's put",
    )?;
    refused(
        target
            .set_head(&reading.token, &vault, &reading.head(manifest.0, None, 5))
            .await,
        Code::Unauthorized,
        "a read token's head",
    )?;
    refused(
        target
            .delete(&reading.token, &vault, &reading.delete(&[manifest.0]))
            .await,
        Code::Unauthorized,
        "a read token's delete",
    )?;
    store(target, &phone, &vault, &object("the writer still writes")).await
}

async fn fence<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let vault = vault_of(&key);
    let first = paired(target, &key).await?;
    let manifest = object("fence manifest");
    store(target, &first, &vault, &manifest).await?;
    ok(
        target
            .set_head(&first.token, &vault, &first.head(manifest.0, None, 10))
            .await,
        "phone one's head",
    )?;
    let second = ok(
        pair_claim(target, &key, 2, Some(manifest.0)).await,
        "phone two's claim",
    )?;
    ensure(second.epoch == 2, || format!("{second:?}"))?;
    let second = Phone::new(second, &key, target.gateway_id());
    let next = object("phone one's next manifest");
    // The old token is gone: every route says MOVED, carrying the claim.
    let put = refused(
        target
            .put(&first.token, &vault, &next.0, &Digest::of(&next.1), &next.1)
            .await,
        Code::Moved,
        "phone one's put",
    )?;
    let head = refused(
        target
            .set_head(
                &first.token,
                &vault,
                &first.head(next.0, Some(manifest.0), 11),
            )
            .await,
        Code::Moved,
        "phone one's head",
    )?;
    let delete = refused(
        target
            .delete(&first.token, &vault, &first.delete(&[manifest.0]))
            .await,
        Code::Moved,
        "phone one's delete",
    )?;
    let read = refused(
        target.head(&first.token, &vault).await,
        Code::Moved,
        "phone one's read",
    )?;
    for answer in [put, head, delete, read] {
        let Refusal::Moved { epoch, ref claim } = answer else {
            return Err(format!("not MOVED: {answer:?}"));
        };
        ensure(
            epoch == 2 && claim.epoch == 2 && claim.head_seen == Some(manifest.0),
            || format!("MOVED must carry the epoch and the claim that superseded it: {answer:?}"),
        )?;
    }
    store(target, &second, &vault, &next).await?;
    ok(
        target
            .set_head(
                &second.token,
                &vault,
                &second.head(next.0, Some(manifest.0), 12),
            )
            .await,
        "phone two's head",
    )?;
    Ok(())
}

async fn stale_claim<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let vault = vault_of(&key);
    let first = paired(target, &key).await?;
    let (old, new) = (object("stale old"), object("stale new"));
    store(target, &first, &vault, &old).await?;
    ok(
        target
            .set_head(&first.token, &vault, &first.head(old.0, None, 1))
            .await,
        "the old head",
    )?;
    let second = ok(pair_claim(target, &key, 2, Some(old.0)).await, "the claim")?;
    let second = Phone::new(second, &key, target.gateway_id());
    store(target, &second, &vault, &new).await?;
    let current = ok(
        target
            .set_head(&second.token, &vault, &second.head(new.0, Some(old.0), 2))
            .await,
        "the new head",
    )?;
    let stale = refused(
        pair_claim(target, &key, 3, Some(old.0)).await,
        Code::HeadConflict,
        "a claim that checked a head that has moved",
    )?;
    ensure(
        stale
            == Refusal::HeadConflict {
                epoch: 2,
                head: Some(Box::new(current)),
            },
        || format!("HEAD_CONFLICT must carry the head as it stands: {stale:?}"),
    )?;
    store(target, &second, &vault, &object("the writer is unmoved")).await?;
    let third = ok(
        pair_claim(target, &key, 3, Some(new.0)).await,
        "the claim at the head as it stands",
    )?;
    ensure(third.epoch == 3, || format!("{third:?}"))
}

/// THE BLINDNESS CANARY.
///
/// Builds an object the way a phone does — a plaintext with a known marker,
/// its BLAKE3 `h`, a name keyed off the backup key, a key derived for that
/// name — seals it with a stand-in that leaves no run of the plaintext, puts
/// it through `PUT` and a bundle, makes it a head, tombstones another, and
/// then scans every byte the gateway keeps at rest, file names included, for
/// the marker, `h` and every key, raw and hex.
///
/// The derivations restate #1080's formulas as a fixture; the normative ones
/// are the vault's. The stand-in seal is not `centraid-sealed/2`: this case
/// proves the gateway adds nothing, and the sealed format is its own proof.
async fn blindness_canary<T: Target>(target: &mut T) -> Outcome {
    const MARKER: &[u8] = b"CENTRAID CANARY: milk, eggs and a doctor's appointment on Thursday";
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);

    let root = blake3::derive_key("centraid gateway canary vault root", &[1]);
    let k_backup = blake3::derive_key("centraid backup v2 root", &root);
    let k_name = blake3::derive_key("centraid backup v2 name", &k_backup);
    let mut stored = Vec::new();
    let mut needles: Vec<(String, Vec<u8>)> = vec![
        ("the root key".to_owned(), root.to_vec()),
        ("K_backup".to_owned(), k_backup.to_vec()),
        ("K_name".to_owned(), k_name.to_vec()),
    ];
    for part in 0..3_u32 {
        let plaintext = [MARKER, &part.to_be_bytes()].concat();
        let h = blake3::hash(&plaintext);
        let name = Name::from_bytes(
            *blake3::keyed_hash(&k_name, &[h.as_bytes(), &part.to_be_bytes()[..]].concat())
                .as_bytes(),
        );
        let object_key =
            blake3::derive_key(&format!("centraid backup v2 object {name}"), &k_backup);
        let sealed = stand_in_seal(&object_key, &plaintext);
        needles.push((format!("plaintext {part}"), plaintext));
        needles.push((format!("h {part}"), h.as_bytes().to_vec()));
        needles.push((format!("key {part}"), object_key.to_vec()));
        stored.push((name, sealed));
    }
    store(target, &phone, &vault, &stored[0]).await?;
    let frames: Vec<Frame> = stored[1..]
        .iter()
        .map(|(name, sealed)| Frame::of(*name, sealed.clone()))
        .collect();
    let answer = ok(target.bundle(&phone.token, &vault, &frames).await, "bundle")?;
    ensure(answer.refused.is_empty(), || format!("{answer:?}"))?;
    ok(
        target
            .set_head(&phone.token, &vault, &phone.head(stored[0].0, None, 1))
            .await,
        "the head",
    )?;
    ok(
        target
            .delete(&phone.token, &vault, &phone.delete(&[stored[2].0]))
            .await,
        "delete",
    )?;

    let at_rest = target.at_rest().await?;
    for (label, needle) in &needles {
        ensure(!contains(&at_rest, needle), || {
            format!("{label} is at rest, raw")
        })?;
        let hex = hex::encode(needle);
        ensure(!contains(&at_rest, hex.as_bytes()), || {
            format!("{label} is at rest, as hex")
        })?;
    }
    // The window really held the ciphertext, so the scan asked something.
    ensure(
        stored.iter().all(|(_, sealed)| contains(&at_rest, sealed)),
        || "the sealed objects are not in the canary's window at all".to_owned(),
    )
}

// ─── the signed protocol (#1191) ─────────────────────────────────────────────

/// Store `label` and make it the head after `prev`, as the phone would.
async fn headed<T: Target>(
    target: &mut T,
    phone: &Phone,
    vault: &VaultId,
    label: &str,
    prev: Option<Name>,
    taken_at_ms: i64,
) -> Result<((Name, Vec<u8>), HeadView), String> {
    let manifest = object(label);
    store(target, phone, vault, &manifest).await?;
    let head = ok(
        target
            .set_head(
                &phone.token,
                vault,
                &phone.head(manifest.0, prev, taken_at_ms),
            )
            .await,
        "a head",
    )?;
    Ok((manifest, head))
}

fn moved_with(refusal: &Refusal, epoch: u64) -> Outcome {
    match refusal {
        Refusal::Moved {
            epoch: found,
            claim,
        } if *found == epoch && claim.epoch == epoch => Ok(()),
        other => Err(format!(
            "expected MOVED at epoch {epoch} with its claim: {other:?}"
        )),
    }
}

/// E2: a token without the vault key cannot set a head.
async fn head_needs_signature<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let gateway = target.gateway_id();
    let manifest = object("signed manifest");
    store(target, &phone, &vault, &manifest).await?;
    let good = phone.head(manifest.0, None, 100);
    let mut by_stranger = good;
    by_stranger.signature = sign_head(
        &identity(9),
        &gateway,
        &HeadFields {
            epoch: 1,
            generation: good.generation,
            writes: good.writes,
            taken_at_ms: 100,
            manifest: manifest.0,
            prev: None,
        },
    );
    let mut moved_after_signing = good;
    moved_after_signing.taken_at_ms = 999;
    let mut blank = good;
    blank.signature = Signature::from_bytes([0; 64]);
    for (what, request) in [
        ("a head signed by another key", by_stranger),
        ("a head edited after it was signed", moved_after_signing),
        ("a head with an empty signature", blank),
    ] {
        refused(
            target.set_head(&phone.token, &vault, &request).await,
            Code::Unauthorized,
            what,
        )?;
    }
    refused(
        target.head(&phone.token, &vault).await,
        Code::NoHead,
        "the head after the refusals",
    )?;
    ok(
        target.set_head(&phone.token, &vault, &good).await,
        "the signed head",
    )?;
    Ok(())
}

/// E3: an old signed head replayed is out of order; a head never falls.
async fn head_never_falls<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let first = object("first");
    let second = object("second");
    store(target, &phone, &vault, &first).await?;
    store(target, &phone, &vault, &second).await?;
    let old = phone.head(first.0, None, 1);
    ok(
        target.set_head(&phone.token, &vault, &old).await,
        "the first head",
    )?;
    let current = ok(
        target
            .set_head(
                &phone.token,
                &vault,
                &phone.head(second.0, Some(first.0), 2),
            )
            .await,
        "the second head",
    )?;
    let replay = refused(
        target.set_head(&phone.token, &vault, &old).await,
        Code::OutOfOrder,
        "the old signed head replayed",
    )?;
    ensure(
        replay
            == Refusal::OutOfOrder {
                epoch: 1,
                generation: current.generation,
                writes: current.writes,
            },
        || format!("OUT_OF_ORDER must carry the standing counters: {replay:?}"),
    )?;
    // A newer generation whose writes fall is refused too (E3 rule 4).
    let falling = phone.head_gw(second.0, Some(second.0), 3, current.generation + 1, 0);
    refused(
        target.set_head(&phone.token, &vault, &falling).await,
        Code::OutOfOrder,
        "a head whose writes fall",
    )?;
    let now = ok(target.head(&phone.token, &vault).await, "the head")?;
    ensure(now == current, || {
        format!("a refused head moved it: {now:?}")
    })
}

/// E3: the generation may jump 256 and no more.
async fn generation_bound<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let (one, _) = headed(target, &phone, &vault, "bound one", None, 1).await?;
    let two = object("bound two");
    store(target, &phone, &vault, &two).await?;
    let current = phone.standing();
    refused(
        target
            .set_head(
                &phone.token,
                &vault,
                &phone.head_at(two.0, Some(one.0), 2, current + MAX_GENERATION_JUMP + 1),
            )
            .await,
        Code::OutOfOrder,
        "a generation 257 ahead",
    )?;
    ok(
        target
            .set_head(
                &phone.token,
                &vault,
                &phone.head_at(two.0, Some(one.0), 2, current + MAX_GENERATION_JUMP),
            )
            .await,
        "a generation 256 ahead",
    )?;
    Ok(())
}

/// E3: a claim resets the counters; the first head of the new epoch is at
/// generation 1 to 256.
async fn claim_resets_generation<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let first = paired(target, &key).await?;
    let vault = vault_of(&key);
    let gateway = target.gateway_id();
    let manifest = object("before the claim");
    store(target, &first, &vault, &manifest).await?;
    ok(
        target
            .set_head(
                &first.token,
                &vault,
                &first.head_at(manifest.0, None, 1, 40),
            )
            .await,
        "a head at generation 40",
    )?;
    let second = ok(
        pair_claim(target, &key, 2, Some(manifest.0)).await,
        "the claim",
    )?;
    let second = Phone::new(second, &key, gateway);
    let next = object("after the claim");
    store(target, &second, &vault, &next).await?;
    for generation in [0, MAX_GENERATION_JUMP + 1] {
        refused(
            target
                .set_head(
                    &second.token,
                    &vault,
                    &second.head_at(next.0, Some(manifest.0), 2, generation),
                )
                .await,
            Code::OutOfOrder,
            "a generation outside 1..=256 after a claim",
        )?;
    }
    ok(
        target
            .set_head(
                &second.token,
                &vault,
                &second.head_at(next.0, Some(manifest.0), 2, 1),
            )
            .await,
        "generation 1 after a claim",
    )?;
    // The head answer carries the standing claim beside the signed head, so
    // a restoring phone can take the writer epoch from signed records only.
    let seen = ok(target.head(&second.token, &vault).await, "the head")?;
    ensure(
        seen.claim
            .is_some_and(|claim| claim.epoch == 2 && claim.head_seen == Some(manifest.0)),
        || format!("the head answer must carry the claim: {seen:?}"),
    )?;
    Ok(())
}

/// E5: a takeover leaves no live older token.
async fn claim_revokes_every_older_token<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let gateway = target.gateway_id();
    let (manifest, _) = headed(target, &phone, &vault, "before takeover", None, 1).await?;
    let reader = ok(pair_read(target, &key).await, "a read grant")?;
    let second = ok(
        pair_claim(target, &key, 2, Some(manifest.0)).await,
        "the claim",
    )?;
    let second = Phone::new(second, &key, gateway);
    let epochs = target.token_epochs(&vault).await?;
    ensure(epochs == vec![2], || {
        format!("tokens below the new epoch are still held: {epochs:?}")
    })?;
    ensure(target.revoked_count(&vault).await? == 2, || {
        "each revoked token leaves a tombstone".to_owned()
    })?;
    let blob = object("late");
    let old_phone = Phone::new(phone.paired, &key, gateway);
    for (who, token) in [
        ("the writer", old_phone.token),
        ("the reader", reader.token),
    ] {
        let mut answers = vec![
            refused(target.head(&token, &vault).await, Code::Moved, "head")?,
            refused(
                target.snapshots(&token, &vault, None, 10).await,
                Code::Moved,
                "snapshots",
            )?,
            refused(
                target.exists(&token, &vault, &[manifest.0]).await,
                Code::Moved,
                "exists",
            )?,
            refused(
                target.objects(&token, &vault, None, 10).await,
                Code::Moved,
                "objects",
            )?,
            refused(
                target.held(&token, &vault, None, 10).await,
                Code::Moved,
                "held",
            )?,
            refused(
                target.get(&token, &vault, &manifest.0, None).await,
                Code::Moved,
                "get",
            )?,
            refused(
                target.stat(&token, &vault, &manifest.0).await,
                Code::Moved,
                "stat",
            )?,
            refused(
                target.fetch(&token, &vault, &[manifest.0]).await,
                Code::Moved,
                "fetch",
            )?,
            refused(
                target
                    .put(&token, &vault, &blob.0, &Digest::of(&blob.1), &blob.1)
                    .await,
                Code::Moved,
                "put",
            )?,
            refused(target.revoke(&token, &vault).await, Code::Moved, "revoke")?,
        ];
        answers.push(refused(
            target
                .bundle(&token, &vault, &[Frame::of(blob.0, blob.1.clone())])
                .await,
            Code::Moved,
            "bundle",
        )?);
        answers.push(refused(
            target
                .set_head(&token, &vault, &old_phone.head(manifest.0, None, 3))
                .await,
            Code::Moved,
            "set head",
        )?);
        answers.push(refused(
            target
                .delete(&token, &vault, &old_phone.delete(&[manifest.0]))
                .await,
            Code::Moved,
            "delete",
        )?);
        answers.push(refused(
            target.undo(&token, &vault, &old_phone.undo(None)).await,
            Code::Moved,
            "undo",
        )?);
        for answer in &answers {
            moved_with(answer, 2).map_err(|detail| format!("{who}: {detail}"))?;
        }
    }
    store(target, &second, &vault, &blob).await
}

/// E4: a `MOVED` carries a claim bound to this gateway, which the old phone
/// verifies against its own vault key.
async fn moved_claim_is_bound<T: Target>(target: &mut T) -> Outcome {
    use crate::rules::signing::verify_claim;
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let gateway = target.gateway_id();
    let (manifest, _) = headed(target, &phone, &vault, "claimed over", None, 1).await?;
    ok(
        pair_claim(target, &key, 2, Some(manifest.0)).await,
        "the claim",
    )?;
    let Refusal::Moved { claim, .. } = refused(
        target.head(&phone.token, &vault).await,
        Code::Moved,
        "the old phone's read",
    )?
    else {
        return Err("not MOVED".to_owned());
    };
    ensure(
        verify_claim(
            &gateway,
            &vault,
            claim.epoch,
            claim.head_seen.as_ref(),
            &claim.nonce,
            &claim.signature,
        ),
        || "the carried claim does not verify at this gateway".to_owned(),
    )?;
    ensure(
        !verify_claim(
            &GatewayId::from_bytes([0xee; 16]),
            &vault,
            claim.epoch,
            claim.head_seen.as_ref(),
            &claim.nonce,
            &claim.signature,
        ),
        || "the claim verifies at another gateway".to_owned(),
    )
}

/// E5: a revoked token hears `MOVED` while its tombstone is kept, at most 64
/// of them, and `UNAUTHORIZED` after.
async fn revoked_tombstones<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let (manifest, _) = headed(target, &phone, &vault, "tombstones", None, 1).await?;
    let mut tokens = vec![phone.token];
    for _ in 0..(MAX_REVOKED_PER_VAULT + 6) {
        tokens.push(ok(pair_read(target, &key).await, "a read grant")?.token);
    }
    ok(
        pair_claim(target, &key, 2, Some(manifest.0)).await,
        "the claim",
    )?;
    ensure(
        target.revoked_count(&vault).await? == MAX_REVOKED_PER_VAULT,
        || "a vault keeps at most 64 tombstones".to_owned(),
    )?;
    let mut heard_moved = 0;
    for token in &tokens {
        match target.head(token, &vault).await {
            Err(Failure::Refused(Refusal::Moved { .. })) => heard_moved += 1,
            Err(Failure::Refused(Refusal::Unauthorized)) => {}
            other => return Err(format!("a revoked token heard {other:?}")),
        }
    }
    ensure(heard_moved == MAX_REVOKED_PER_VAULT, || {
        format!("{heard_moved} tokens heard MOVED")
    })?;
    target.advance(REVOKED_TOKEN_KEEP_MS).await;
    target.purge().await?;
    ensure(target.revoked_count(&vault).await? == 0, || {
        "the sweep keeps tombstones past their year".to_owned()
    })?;
    for token in &tokens {
        refused(
            target.head(token, &vault).await,
            Code::Unauthorized,
            "a revoked token after its tombstone is pruned",
        )?;
    }
    Ok(())
}

/// E5 step 3: a takeover lifts every held delete.
async fn claim_cancels_holds<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let gateway = target.gateway_id();
    let (old, _) = headed(target, &phone, &vault, "old manifest", None, 1).await?;
    let (new, _) = headed(target, &phone, &vault, "new manifest", Some(old.0), 2).await?;
    let part = object("a part");
    store(target, &phone, &vault, &part).await?;
    tombstone(target, &phone, &vault, &[old.0, part.0]).await?;
    let held = ok(target.held(&phone.token, &vault, None, 10).await, "held")?;
    ensure(held.len() == 2, || format!("{held:?}"))?;
    let second = ok(pair_claim(target, &key, 2, Some(new.0)).await, "the claim")?;
    let held = ok(target.held(&second.token, &vault, None, 10).await, "held")?;
    ensure(held.is_empty(), || {
        format!("a takeover must lift every hold: {held:?}")
    })?;
    let missing = ok(
        target.exists(&second.token, &vault, &[old.0, part.0]).await,
        "exists",
    )?;
    ensure(missing.is_empty(), || {
        format!("the names are live again: {missing:?}")
    })?;
    let snapshots = ok(
        snapshots_all(target, &second.token, &vault).await,
        "snapshots",
    )?;
    ensure(
        snapshots
            .iter()
            .all(|snapshot| snapshot.held_at_ms.is_none()),
        || format!("a snapshot is still held: {snapshots:?}"),
    )?;
    let _ = gateway;
    ensure(watch(target, GRACE_MS + 1).await? == 0, || {
        "a lifted hold purged".to_owned()
    })
}

/// E6: a delete needs the vault key.
async fn delete_needs_signature<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let gateway = target.gateway_id();
    let part = object("a part");
    let other = object("another part");
    store(target, &phone, &vault, &part).await?;
    let generation = phone.standing() + 1;
    let by_stranger = DeleteRequest {
        names: vec![part.0],
        generation,
        signature: sign_delete(&identity(9), &gateway, 1, generation, &[part.0]),
    };
    let for_other_names = DeleteRequest {
        names: vec![part.0],
        generation,
        signature: sign_delete(&key, &gateway, 1, generation, &[other.0]),
    };
    let unsigned = DeleteRequest {
        names: vec![part.0],
        generation,
        signature: Signature::from_bytes([0; 64]),
    };
    for (what, request) in [
        ("a delete signed by another key", by_stranger),
        ("a signature over other names", for_other_names),
        ("an empty signature", unsigned),
    ] {
        refused(
            target.delete(&phone.token, &vault, &request).await,
            Code::Unauthorized,
            what,
        )?;
    }
    let held = ok(target.held(&phone.token, &vault, None, 10).await, "held")?;
    ensure(held.is_empty(), || {
        format!("a refused delete held: {held:?}")
    })
}

/// E6: a signed delete is held for seven days and stays listed.
async fn delete_is_held<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let (old, _) = headed(target, &phone, &vault, "an old manifest", None, 1).await?;
    let (new, _) = headed(target, &phone, &vault, "the new manifest", Some(old.0), 2).await?;
    let part = object("a part");
    store(target, &phone, &vault, &part).await?;
    tombstone(target, &phone, &vault, &[old.0, part.0]).await?;
    for (name, bytes) in [&old, &part] {
        let served = ok(target.get(&phone.token, &vault, name, None).await, "get")?;
        ensure(&served == bytes, || {
            "a held object is not served".to_owned()
        })?;
    }
    let fetched = ok(
        target.fetch(&phone.token, &vault, &[old.0, part.0]).await,
        "fetch",
    )?;
    ensure(fetched.len() == 2, || {
        "fetch leaves a held object out".to_owned()
    })?;
    let missing = ok(
        target.exists(&phone.token, &vault, &[old.0, part.0]).await,
        "exists",
    )?;
    ensure(missing.len() == 2, || {
        "a held name reads as live".to_owned()
    })?;
    let held = ok(target.held(&phone.token, &vault, None, 10).await, "held")?;
    ensure(held.len() == 2, || format!("{held:?}"))?;
    for entry in &held {
        ensure(entry.purge_after_ms == entry.held_at_ms + GRACE_MS, || {
            format!("a hold is seven days: {entry:?}")
        })?;
        let kind = if entry.name == old.0 {
            HeldKind::Snapshot
        } else {
            HeldKind::Object
        };
        ensure(entry.kind == kind, || format!("{entry:?}"))?;
    }
    let snapshots = ok(
        snapshots_all(target, &phone.token, &vault).await,
        "snapshots",
    )?;
    ensure(
        snapshots.iter().map(|s| s.name).collect::<Vec<_>>() == vec![old.0, new.0]
            && snapshots[0].held_at_ms.is_some()
            && snapshots[0].purge_after_ms.is_some()
            && snapshots[1].held_at_ms.is_none(),
        || format!("a held snapshot stays listed, with its dates: {snapshots:?}"),
    )?;
    let listed = ok(target.objects(&phone.token, &vault, None, 10).await, "list")?;
    ensure(
        listed
            .iter()
            .all(|entry| entry.name != old.0 && entry.name != part.0),
        || "a held object is listed live".to_owned(),
    )?;
    // The gateway's clock moves only when told, so the edge is exact.
    ensure(watch(target, GRACE_MS - 1).await? == 0, || {
        "purged one tick before the deadline".to_owned()
    })?;
    let purged = watch(target, 2).await?;
    ensure(purged == 2, || {
        format!("purged {purged} after the deadline")
    })?;
    let snapshots = ok(
        snapshots_all(target, &phone.token, &vault).await,
        "snapshots",
    )?;
    ensure(snapshots.len() == 1, || {
        format!("a purged snapshot is still listed: {snapshots:?}")
    })
}

/// E6: a recorded delete, replayed, is out of order.
async fn delete_replay<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let part = object("a part");
    store(target, &phone, &vault, &part).await?;
    let recorded = phone.delete(&[part.0]);
    ok(
        target.delete(&phone.token, &vault, &recorded).await,
        "the delete",
    )?;
    store(target, &phone, &vault, &part).await?;
    refused(
        target.delete(&phone.token, &vault, &recorded).await,
        Code::OutOfOrder,
        "the recorded delete replayed",
    )?;
    let missing = ok(
        target.exists(&phone.token, &vault, &[part.0]).await,
        "exists",
    )?;
    ensure(missing.is_empty(), || {
        "a replay held a live name".to_owned()
    })
}

/// E2, E6: the head cannot be deleted; a held snapshot keeps its manifest.
async fn head_and_snapshot_keep_manifest<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let (old, _) = headed(target, &phone, &vault, "older", None, 1).await?;
    let (new, _) = headed(target, &phone, &vault, "newer", Some(old.0), 2).await?;
    let answer = ok(
        target
            .delete(&phone.token, &vault, &phone.delete(&[new.0, old.0]))
            .await,
        "delete",
    )?;
    ensure(
        answer.deleted == vec![old.0]
            && answer.refused.len() == 1
            && answer.refused[0].name == new.0
            && answer.refused[0].code == Code::HeadInUse,
        || format!("{answer:?}"),
    )?;
    let served = ok(target.get(&phone.token, &vault, &old.0, None).await, "get")?;
    ensure(served == old.1, || {
        "a held snapshot's manifest is not served".to_owned()
    })?;
    let head = ok(target.head(&phone.token, &vault).await, "head")?;
    ensure(head.name == new.0, || "the head moved".to_owned())
}

/// E6: a signed undo lifts holds; an undo of everything has null names.
async fn undo_lifts_holds<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let (a, b) = (object("part a"), object("part b"));
    store(target, &phone, &vault, &a).await?;
    store(target, &phone, &vault, &b).await?;
    tombstone(target, &phone, &vault, &[a.0, b.0]).await?;
    let mut forged = phone.undo(Some(&[a.0]));
    forged.signature = Signature::from_bytes([0; 64]);
    refused(
        target.undo(&phone.token, &vault, &forged).await,
        Code::Unauthorized,
        "an unsigned undo",
    )?;
    let one = ok(
        target
            .undo(&phone.token, &vault, &phone.undo(Some(&[a.0])))
            .await,
        "an undo of one name",
    )?;
    ensure(one.undone == 1, || format!("{one:?}"))?;
    let missing = ok(
        target.exists(&phone.token, &vault, &[a.0, b.0]).await,
        "exists",
    )?;
    ensure(missing == vec![b.0], || format!("{missing:?}"))?;
    let recorded = phone.undo(None);
    let rest = ok(
        target.undo(&phone.token, &vault, &recorded).await,
        "an undo of everything",
    )?;
    ensure(rest.undone == 1, || format!("{rest:?}"))?;
    refused(
        target.undo(&phone.token, &vault, &recorded).await,
        Code::OutOfOrder,
        "an undo replayed",
    )?;
    let held = ok(target.held(&phone.token, &vault, None, 10).await, "held")?;
    ensure(held.is_empty(), || format!("{held:?}"))
}

/// E7: pairing by secret needs the vault key.
async fn pair_needs_signature<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let member = identity(1);
    let photographer = identity(9);
    let secret = target.mint_secret().await?;
    let gateway = target.gateway_id();
    // The attacker has the QR's secret and the member's vault id.
    let nonce = fresh_nonce(target).await.map_err(|f| format!("{f:?}"))?;
    let squat = PairRequest {
        vault_id: vault_of(&member),
        label: "photographer".to_owned(),
        kind: PairKind::Secret,
        nonce,
        secret: Some(SecretBody {
            secret,
            signature: sign_pair(&photographer, &gateway, &secret, &nonce),
        }),
        claim: None,
        read: None,
    };
    refused(
        target.pair(&squat).await,
        Code::Unauthorized,
        "a pairing signed by another key",
    )?;
    // The secret is not spent and the vault was not created.
    ok(
        pair_secret(target, &member, secret).await,
        "the member's own pairing with the same secret",
    )?;
    Ok(())
}

/// E7: the pairing signature binds the secret, the gateway and the nonce.
async fn pair_signature_binds<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let gateway = target.gateway_id();
    let (one, two) = (target.mint_secret().await?, target.mint_secret().await?);
    let nonce = fresh_nonce(target).await.map_err(|f| format!("{f:?}"))?;
    let request = |secret: Secret, signed_secret: Secret, signed_gateway: &GatewayId| PairRequest {
        vault_id: vault_of(&key),
        label: "phone".to_owned(),
        kind: PairKind::Secret,
        nonce,
        secret: Some(SecretBody {
            secret,
            signature: sign_pair(&key, signed_gateway, &signed_secret, &nonce),
        }),
        claim: None,
        read: None,
    };
    refused(
        target.pair(&request(two, one, &gateway)).await,
        Code::Unauthorized,
        "a signature made for another secret",
    )?;
    // That refusal left the nonce unspent (R2); a fresh one for each try.
    let nonce2 = fresh_nonce(target).await.map_err(|f| format!("{f:?}"))?;
    let elsewhere = PairRequest {
        nonce: nonce2,
        secret: Some(SecretBody {
            secret: two,
            signature: sign_pair(&key, &GatewayId::from_bytes([0xee; 16]), &two, &nonce2),
        }),
        ..request(two, two, &gateway)
    };
    refused(
        target.pair(&elsewhere).await,
        Code::Unauthorized,
        "a signature made for another gateway",
    )?;
    let nonce3 = fresh_nonce(target).await.map_err(|f| format!("{f:?}"))?;
    let good = PairRequest {
        nonce: nonce3,
        secret: Some(SecretBody {
            secret: one,
            signature: sign_pair(&key, &gateway, &one, &nonce3),
        }),
        ..request(one, one, &gateway)
    };
    let good = ok(target.pair(&good).await, "the good pairing")?;
    ensure(good.epoch == 1, || format!("{good:?}"))?;
    // A spent nonce, signed afresh over another secret, is still spent.
    let spent = PairRequest {
        vault_id: vault_of(&identity(2)),
        nonce: nonce3,
        secret: Some(SecretBody {
            secret: two,
            signature: sign_pair(&identity(2), &gateway, &two, &nonce3),
        }),
        ..request(two, two, &gateway)
    };
    refused(
        target.pair(&spent).await,
        Code::Unauthorized,
        "a spent nonce",
    )?;
    ok(
        pair_secret(target, &identity(2), two).await,
        "the secret none of the refusals spent",
    )?;
    Ok(())
}

/// E5: a nonce is good for one pair request.
async fn nonce_single_use<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    paired(target, &key).await?;
    let gateway = target.gateway_id();
    let grant = ok(read_request(target, &key, &gateway).await, "a read")?;
    ok(target.pair(&grant).await, "the read grant")?;
    refused(
        target.pair(&grant).await,
        Code::Unauthorized,
        "the recorded read grant, replayed",
    )?;
    Ok(())
}

/// E5: a claim cannot be replayed after a revoke.
async fn claim_not_replayable<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let gateway = target.gateway_id();
    let (manifest, _) = headed(target, &phone, &vault, "claimed", None, 1).await?;
    let claim = ok(
        claim_request(target, &key, &gateway, 2, Some(manifest.0)).await,
        "a claim",
    )?;
    let second = ok(target.pair(&claim).await, "the claim")?;
    ok(target.revoke(&second.token, &vault).await, "the revoke")?;
    refused(
        target.pair(&claim).await,
        Code::Unauthorized,
        "the claim bytes replayed",
    )?;
    ensure(target.token_epochs(&vault).await?.is_empty(), || {
        "a replayed claim minted a token".to_owned()
    })
}

/// E5, R2: a nonce lives five minutes; the sweep prunes the spent ones.
async fn nonce_expires<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    paired(target, &key).await?;
    let gateway = target.gateway_id();
    let grant = ok(read_request(target, &key, &gateway).await, "a read")?;
    target.advance(NONCE_TTL_MS).await;
    refused(
        target.pair(&grant).await,
        Code::Unauthorized,
        "a nonce past its time",
    )?;
    // A nonce that was spent leaves one row until its time is out and the
    // sweep has run (the pairing's own is one already).
    let before = target.nonce_rows().await?.len();
    ok(
        pair_read(target, &key).await,
        "a read grant on a fresh nonce",
    )?;
    ensure(target.nonce_rows().await?.len() == before + 1, || {
        "a spent nonce leaves one row".to_owned()
    })?;
    target.advance(NONCE_TTL_MS).await;
    target.purge().await?;
    let rows = target.nonce_rows().await?;
    ensure(rows.is_empty(), || {
        format!("{} expired nonces survive the sweep", rows.len())
    })
}

/// E5, R2: at 4096 nonces spent in the last five minutes the next issue is
/// `BUSY`. Only a valid signature spends one, so the cap is reached by 4096
/// read grants and not by asking.
async fn nonces_bounded<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    paired(target, &key).await?;
    // The pairing spent one already.
    for _ in 1..MAX_LIVE_NONCES {
        ok(pair_read(target, &key).await, "a read grant under the cap")?;
    }
    let busy = refused(target.nonce().await, Code::Busy, "a nonce at the cap")?;
    ensure(
        busy == Refusal::Busy {
            retry_after_ms: 60_000,
        },
        || format!("{busy:?}"),
    )?;
    target.advance(NONCE_TTL_MS).await;
    ok(target.nonce().await, "a nonce after the old ones expire")?;
    Ok(())
}

/// R2: the nonce route writes nothing, however often it is asked; and a
/// legitimate claim afterwards succeeds.
async fn nonce_route_writes_nothing<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let (manifest, _) = headed(target, &phone, &vault, "before the flood", None, 1).await?;
    let before = target.nonce_rows().await?.len();
    for _ in 0..10_000 {
        ok(target.nonce().await, "an unauthenticated nonce")?;
    }
    let rows = target.nonce_rows().await?;
    ensure(rows.len() == before, || {
        format!("the nonce route wrote {} rows", rows.len() - before)
    })?;
    ok(
        pair_claim(target, &key, 2, Some(manifest.0)).await,
        "a legitimate claim after the flood",
    )?;
    Ok(())
}

/// R2: a forged, foreign, expired or replayed nonce is `UNAUTHORIZED`; and a
/// request signed by the wrong key leaves the nonce unspent — which gains an
/// attacker nothing, because what makes a request good is the vault key's
/// signature over that nonce, which they cannot make.
async fn nonce_is_checked<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    paired(target, &key).await?;
    let gateway = target.gateway_id();
    let signed_read = |nonce: Nonce, by: &SigningKey| PairRequest {
        vault_id: vault_of(&key),
        label: "restoring phone".to_owned(),
        kind: PairKind::Read,
        nonce,
        secret: None,
        claim: None,
        read: Some(ReadBody {
            signature: sign_read(by, &gateway, &nonce),
        }),
    };
    let baseline = target.nonce_rows().await?.len();
    let honest = ok(target.nonce().await, "a nonce")?.nonce;
    // A forged MAC, a forged time.
    for byte in [24, 39, 20] {
        let mut bytes = *honest.as_bytes();
        bytes[byte] ^= 1;
        refused(
            target
                .pair(&signed_read(Nonce::from_bytes(bytes), &key))
                .await,
            Code::Unauthorized,
            "a nonce with a forged byte",
        )?;
    }
    // Another gateway's: a nonce minted under another key.
    let now = ok(target.info().await, "info")?.time_ms;
    let foreign = crate::rules::nonce::mint(&[0x99; 32], &gateway, [3; 16], now);
    refused(
        target.pair(&signed_read(foreign, &key)).await,
        Code::Unauthorized,
        "a nonce from another gateway",
    )?;
    // The wrong key's signature does not spend the nonce ...
    refused(
        target.pair(&signed_read(honest, &identity(9))).await,
        Code::Unauthorized,
        "a wrong-key signature",
    )?;
    ensure(target.nonce_rows().await?.len() == baseline, || {
        "a wrong-key signature spent a nonce".to_owned()
    })?;
    // ... so the honest phone's own request on it still works, once.
    ok(
        target.pair(&signed_read(honest, &key)).await,
        "the honest request on the same nonce",
    )?;
    refused(
        target.pair(&signed_read(honest, &key)).await,
        Code::Unauthorized,
        "the same nonce again",
    )?;
    // Expired.
    let old = ok(target.nonce().await, "a nonce")?.nonce;
    target.advance(NONCE_TTL_MS).await;
    refused(
        target.pair(&signed_read(old, &key)).await,
        Code::Unauthorized,
        "an expired nonce",
    )?;
    Ok(())
}

/// R2: the spent-nonce table holds nothing that names a vault — every column
/// of every row is looked at.
async fn canary_nonce<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let (manifest, _) = headed(target, &phone, &vault, "a vault with a name", None, 1).await?;
    ok(pair_read(target, &key).await, "a read grant")?;
    ok(
        pair_claim(target, &key, 2, Some(manifest.0)).await,
        "a claim",
    )?;
    let rows = target.nonce_rows().await?;
    ensure(rows.len() == 3, || {
        format!(
            "three spent nonces (pairing, grant, claim), three rows: {}",
            rows.len()
        )
    })?;
    for row in &rows {
        ensure(
            !contains(row, vault.as_bytes()) && !contains(row, phone.token.as_bytes()),
            || "a nonce row names a vault or a token".to_owned(),
        )?;
        ensure(row.len() == 16 + 8, || {
            format!(
                "a nonce row holds more than an id and a time: {} bytes",
                row.len()
            )
        })?;
    }
    Ok(())
}

/// E14: a head dated more than five minutes ahead of the gateway is refused.
async fn taken_at_bounded<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    // The clock moves only when told: the bound is exact.
    let now = ok(target.info().await, "info")?.time_ms;
    let (first, second) = (object("on time"), object("from the future"));
    store(target, &phone, &vault, &first).await?;
    store(target, &phone, &vault, &second).await?;
    ok(
        target
            .set_head(
                &phone.token,
                &vault,
                &phone.head(first.0, None, now + MAX_CLOCK_AHEAD_MS),
            )
            .await,
        "a head exactly at the bound",
    )?;
    let refusal = refused(
        target
            .set_head(
                &phone.token,
                &vault,
                &phone.head(second.0, Some(first.0), now + MAX_CLOCK_AHEAD_MS + 1),
            )
            .await,
        Code::ClockAhead,
        "a head one millisecond past the bound",
    )?;
    match refusal {
        Refusal::ClockAhead { skew_ms } if skew_ms == MAX_CLOCK_AHEAD_MS + 1 => Ok(()),
        other => Err(format!("CLOCK_AHEAD must carry the skew: {other:?}")),
    }
}

/// E14: at most 64 live pairing secrets; one more drops the oldest.
async fn secrets_bounded<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let mut secrets = Vec::new();
    for _ in 0..=MAX_LIVE_SECRETS {
        secrets.push(target.mint_secret().await?);
        target.advance(1).await;
    }
    refused(
        pair_secret(target, &identity(1), secrets[0]).await,
        Code::Unauthorized,
        "the oldest secret, dropped by the 65th",
    )?;
    ok(
        pair_secret(target, &identity(2), secrets[1]).await,
        "the second oldest, still live",
    )?;
    // Spent and expired secrets are pruned a week later.
    target.advance(SECRET_TTL_MS + 7 * 86_400_000).await;
    target.purge().await?;
    ensure(target.secret_count().await? == 0, || {
        "old secrets survive the sweep".to_owned()
    })
}

/// E6: a frozen vault refuses writes and answers reads.
async fn frozen_vault<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let gateway = target.gateway_id();
    let (old, _) = headed(target, &phone, &vault, "frozen old", None, 1).await?;
    let (new, _) = headed(target, &phone, &vault, "frozen new", Some(old.0), 2).await?;
    let part = object("frozen part");
    store(target, &phone, &vault, &part).await?;
    tombstone(target, &phone, &vault, &[part.0]).await?;
    let reader = ok(pair_read(target, &key).await, "a read grant")?;
    let frozen_at = ok(target.info().await, "info")?.time_ms;
    target.freeze(&vault).await?;
    let mut answers = Vec::new();
    let blob = object("write while frozen");
    answers.push(refused(
        target
            .put(&phone.token, &vault, &blob.0, &Digest::of(&blob.1), &blob.1)
            .await,
        Code::Frozen,
        "put",
    )?);
    answers.push(refused(
        target
            .bundle(&phone.token, &vault, &[Frame::of(blob.0, blob.1.clone())])
            .await,
        Code::Frozen,
        "bundle",
    )?);
    answers.push(refused(
        target
            .set_head(&phone.token, &vault, &phone.head(old.0, Some(new.0), 3))
            .await,
        Code::Frozen,
        "set head",
    )?);
    answers.push(refused(
        target
            .delete(&phone.token, &vault, &phone.delete(&[old.0]))
            .await,
        Code::Frozen,
        "delete",
    )?);
    answers.push(refused(
        target.undo(&phone.token, &vault, &phone.undo(None)).await,
        Code::Frozen,
        "undo",
    )?);
    answers.push(refused(
        pair_claim(target, &key, 2, Some(new.0)).await,
        Code::Frozen,
        "claim",
    )?);
    let again = target.mint_secret().await?;
    answers.push(refused(
        pair_secret(target, &key, again).await,
        Code::Frozen,
        "pairing by secret",
    )?);
    for answer in answers {
        match answer {
            Refusal::Frozen { since_ms } if since_ms == frozen_at => {}
            other => return Err(format!("FROZEN must carry since_ms: {other:?}")),
        }
    }
    // Reads, nonces and read grants answer.
    ok(target.head(&phone.token, &vault).await, "head")?;
    ok(
        target.snapshots(&phone.token, &vault, None, 10).await,
        "snapshots",
    )?;
    ok(target.held(&phone.token, &vault, None, 10).await, "held")?;
    ok(
        target.exists(&phone.token, &vault, &[part.0]).await,
        "exists",
    )?;
    ok(
        target.objects(&phone.token, &vault, None, 10).await,
        "objects",
    )?;
    ok(target.get(&phone.token, &vault, &part.0, None).await, "get")?;
    ok(target.fetch(&phone.token, &vault, &[part.0]).await, "fetch")?;
    ok(target.nonce().await, "nonce")?;
    ok(pair_read(target, &key).await, "a read grant")?;
    let _ = gateway;
    // The purge skips the vault, however late.
    ensure(watch(target, GRACE_MS + 1).await? == 0, || {
        "a frozen vault was purged".to_owned()
    })?;
    ok(
        target.revoke(&reader.token, &vault).await,
        "revoke, excepted",
    )?;
    Ok(())
}

/// E6: unfreezing gives back the time the vault was frozen.
async fn unfreeze_gives_time_back<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let part = object("frozen part");
    store(target, &phone, &vault, &part).await?;
    tombstone(target, &phone, &vault, &[part.0]).await?;
    let before = ok(target.held(&phone.token, &vault, None, 10).await, "held")?;
    target.freeze(&vault).await?;
    target.advance(3 * 86_400_000).await;
    let lasted = target.unfreeze(&vault).await?;
    ensure(lasted == 3 * 86_400_000, || format!("lasted {lasted}"))?;
    let after = ok(target.held(&phone.token, &vault, None, 10).await, "held")?;
    ensure(
        after[0].purge_after_ms - before[0].purge_after_ms == lasted,
        || format!("every hold rises by exactly the frozen time: {before:?} {after:?}"),
    )?;
    store(target, &phone, &vault, &object("writes again")).await
}

/// E6: the operator's undo lifts every hold, and the head stays.
async fn operator_undo_all<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let (old, _) = headed(target, &phone, &vault, "undo old", None, 1).await?;
    let (new, head) = headed(target, &phone, &vault, "undo new", Some(old.0), 2).await?;
    let part = object("undo part");
    store(target, &phone, &vault, &part).await?;
    tombstone(target, &phone, &vault, &[old.0, part.0]).await?;
    target.freeze(&vault).await?;
    ensure(target.operator_undo(&vault).await? == 2, || {
        "two holds".to_owned()
    })?;
    target.unfreeze(&vault).await?;
    let missing = ok(
        target
            .exists(&phone.token, &vault, &[old.0, part.0, new.0])
            .await,
        "exists",
    )?;
    ensure(missing.is_empty(), || format!("{missing:?}"))?;
    let now = ok(target.head(&phone.token, &vault).await, "head")?;
    ensure(now == head, || {
        "the operator's undo moved the head".to_owned()
    })
}

/// One held part, and how it stands: a fresh gateway, one phone, one name
/// held for deletion at the clock's reading.
async fn one_hold<T: Target>(
    target: &mut T,
) -> Result<(Phone, VaultId, crate::rules::wire::HeldEntry), String> {
    target.reset().await?;
    let key = identity(1);
    let phone = paired(target, &key).await?;
    let vault = vault_of(&key);
    let part = object("held through a gap");
    store(target, &phone, &vault, &part).await?;
    tombstone(target, &phone, &vault, &[part.0]).await?;
    let held = ok(target.held(&phone.token, &vault, None, 10).await, "held")?;
    ensure(held.len() == 1, || format!("{held:?}"))?;
    Ok((phone, vault, held[0]))
}

/// E6, as amended (#1191, R1): a hold counts only the time the gateway was
/// watching. A gap of more than three sweep intervals since the last sweep —
/// a clock step, a night asleep, a spoofed time — moves every hold later by
/// the whole gap before anything is purged, so it never ends a hold early.
async fn gap_not_counted<T: Target>(target: &mut T) -> Outcome {
    // Eight days: under the old fourteen-day threshold, so the hold was purged
    // at once. Now nothing is purged and the hold moved by exactly the gap.
    let (phone, vault, before) = one_hold(target).await?;
    let jump = 8 * DAY_MS;
    target.advance(jump).await;
    ensure(target.purge().await? == 0, || {
        "a hold was purged across an eight-day gap".to_owned()
    })?;
    let after = ok(target.held(&phone.token, &vault, None, 10).await, "held")?;
    ensure(
        after[0].purge_after_ms == before.purge_after_ms + jump,
        || format!("shifted by exactly the jump: {before:?} {after:?}"),
    )?;

    // Exactly three intervals counts; one millisecond more does not.
    let (phone, vault, before) = one_hold(target).await?;
    target
        .advance(PURGE_GAP_INTERVALS * PURGE_INTERVAL_MS)
        .await;
    target.purge().await?;
    let after = ok(target.held(&phone.token, &vault, None, 10).await, "held")?;
    ensure(after[0].purge_after_ms == before.purge_after_ms, || {
        format!("three intervals are watched time: {before:?} {after:?}")
    })?;
    let (phone, vault, before) = one_hold(target).await?;
    let gap = PURGE_GAP_INTERVALS * PURGE_INTERVAL_MS + 1;
    target.advance(gap).await;
    target.purge().await?;
    let after = ok(target.held(&phone.token, &vault, None, 10).await, "held")?;
    ensure(
        after[0].purge_after_ms == before.purge_after_ms + gap,
        || format!("three intervals and a millisecond are not: {before:?} {after:?}"),
    )?;

    // A year: the hold still has its full remaining week.
    let (phone, vault, _) = one_hold(target).await?;
    target.advance(365 * DAY_MS).await;
    let now = ok(target.info().await, "info")?.time_ms;
    ensure(target.purge().await? == 0, || {
        "a hold ended across a year".to_owned()
    })?;
    let after = ok(target.held(&phone.token, &vault, None, 10).await, "held")?;
    ensure(after[0].purge_after_ms == now + GRACE_MS, || {
        format!("a full remaining week after a year: {after:?}")
    })?;
    ensure(watch(target, GRACE_MS + 1).await? == 1, || {
        "and then it ends".to_owned()
    })?;

    // A clock stepped back purges nothing and shortens nothing.
    let (phone, vault, before) = one_hold(target).await?;
    target.advance(-DAY_MS).await;
    ensure(target.purge().await? == 0, || {
        "a backwards clock purged".to_owned()
    })?;
    let after = ok(target.held(&phone.token, &vault, None, 10).await, "held")?;
    ensure(after[0].purge_after_ms == before.purge_after_ms, || {
        format!("a backwards clock moved a hold: {before:?} {after:?}")
    })
}

/// A stand-in for a sealed part: a keyed XOF stream over the plaintext and a
/// 32-byte tag. Shares no run with the plaintext, its hash or the key.
fn stand_in_seal(key: &[u8; 32], plaintext: &[u8]) -> Vec<u8> {
    let mut stream = vec![0_u8; plaintext.len()];
    blake3::Hasher::new_keyed(key)
        .update(b"stream")
        .finalize_xof()
        .fill(&mut stream);
    let mut sealed: Vec<u8> = plaintext
        .iter()
        .zip(&stream)
        .map(|(byte, pad)| byte ^ pad)
        .collect();
    let tag = blake3::keyed_hash(key, &sealed);
    sealed.extend_from_slice(tag.as_bytes());
    sealed
}

/// THE CREDENTIAL CANARY: a bearer token and a pairing secret are
/// credentials, so neither is at rest — only their BLAKE3 is.
async fn credential_canary<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let secret = target.mint_secret().await?;
    let phone = ok(pair_secret(target, &key, secret).await, "pairing")?;
    let at_rest = target.at_rest().await?;
    for (label, raw) in [
        ("the token", phone.token.as_bytes().to_vec()),
        ("the pairing secret", secret.as_bytes().to_vec()),
    ] {
        ensure(!contains(&at_rest, &raw), || {
            format!("{label} is at rest, raw")
        })?;
        ensure(!contains(&at_rest, hex::encode(&raw).as_bytes()), || {
            format!("{label} is at rest, as hex")
        })?;
    }
    let hash = phone.token.hash();
    ensure(
        contains(&at_rest, hash.as_bytes()) || contains(&at_rest, hash.hex().as_bytes()),
        || "the token's hash is not at rest either, so the window missed the state".to_owned(),
    )
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}
