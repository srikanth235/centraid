//! THE SUITE BOTH ADAPTERS MUST PASS (#1029 §3).
//!
//! *Neither deployment is the reference implementation: the protocol and its
//! conformance suite are.* So the suite is a **library function**, not a
//! `#[test]`: an adapter may live outside `cargo test`'s reach entirely, and a
//! suite that only the standalone adapter could run would be a suite that
//! checks one of the two things it exists to compare.
//!
//! An adapter implements [`Harness`] — which is the whole of what a gateway
//! needs beyond its ports: a way to reset, a way to register a vault, the `PUT`
//! a phone would make to a presigned target, and two windows for the canary —
//! and calls [`run`]. The answer is a [`Report`] of named cases, which a
//! `#[test]` can assert on and a Worker can serialise.
//!
//! # What it proves, and what it cannot
//!
//! It proves the rules: the checksum in **both** modes, refusing to presign a
//! committed name, the manifest compare-and-set under a two-device race,
//! version skew both ways, the retention floor and the size guard and the
//! delete rate limit under an abuse run, the lease's two different refusals,
//! quota and lapse, the blind scrub, the grace period, and the canary.
//!
//! It cannot prove three things, and they are named here rather than left to be
//! discovered:
//!
//! 1. **That the store's compare-and-set is really atomic.** The race case
//!    drives two writers in sequence, because a suite cannot make a Durable
//!    Object and a SQLite file concurrent in the same way. What it proves is
//!    that the *rule* refuses the loser; that the adapter applies it under
//!    something that serialises is [`crate::store::StateStore::compare_and_set_head`]'s
//!    contract and the adapter's own tests.
//! 2. **That attest mode catches a name that lies about its bytes.** It cannot,
//!    and that is a property of attest-only stores rather than a gap in the
//!    suite — [`crate::checksum::ChecksumMode`] says so, and the suite asserts
//!    the difference between the modes instead of pretending it away.
//! 3. **That the ciphertext is really ciphertext.** The canary proves that
//!    nothing the gateway path touches copies a plaintext or a plaintext hash
//!    into the store. It cannot prove the phone sealed properly; that is
//!    `crates/media`'s vectors.

use crate::checksum::{AttestedChecksum, ChecksumMode};
use crate::engine::{Caller, CommitInput, Fault, Gateway};
use crate::error::Refusal;
use crate::ids::{Generation, Key32, ObjectKind, ObjectName, VaultId};
use crate::lease::LeaseState;
use crate::plan::{self, Plan};
use crate::retention::{DeleteRefusal, Policy, Verdict};
use crate::store::{ByteStore, StateStore, StoreFault, UploadTarget, VaultState};
use crate::time::{Duration, ServerTime};
use crate::upload::Declaration;
use crate::version::{self, Range, Skew};

/// One case's verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Case {
    pub name: &'static str,
    pub passed: bool,
    /// What happened, when it did not pass. Empty on a pass.
    pub detail: String,
}

/// Every case's verdict.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub cases: Vec<Case>,
}

impl Report {
    fn pass(&mut self, name: &'static str) {
        self.cases.push(Case {
            name,
            passed: true,
            detail: String::new(),
        });
    }

    fn fail(&mut self, name: &'static str, detail: impl Into<String>) {
        self.cases.push(Case {
            name,
            passed: false,
            detail: detail.into(),
        });
    }

    fn check(&mut self, name: &'static str, held: bool, detail: impl Into<String>) {
        if held {
            self.pass(name);
        } else {
            self.fail(name, detail);
        }
    }

    /// Did every case pass?
    #[must_use]
    pub fn is_green(&self) -> bool {
        self.cases.iter().all(|case| case.passed)
    }

    /// The cases that did not.
    #[must_use]
    pub fn failures(&self) -> Vec<&Case> {
        self.cases.iter().filter(|case| !case.passed).collect()
    }

    /// One line per case, for a log or a Worker's response body.
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

/// What an adapter supplies so the suite can drive it.
///
/// Everything here is something a *phone* or an *operator* does, not something
/// a rule does: the rules are reached only through [`Gateway`].
#[expect(
    async_fn_in_trait,
    reason = "a Worker's futures are !Send; see crate::store"
)]
pub trait Harness {
    type State: StateStore;
    type Bytes: ByteStore;

    /// Throw everything away and come back with a gateway whose byte store is
    /// in `mode`. Called at the start of every case that touches storage, so no
    /// case can pass on another's leftovers.
    async fn reset(&mut self, mode: ChecksumMode, policy: Policy) -> Result<(), StoreFault>;

    /// The gateway under test.
    fn gateway(&mut self) -> &mut Gateway<Self::State, Self::Bytes>;

    /// The adapter's own admission path, which is the one place the two
    /// deployments differ and which ends in the same state either way.
    async fn register(&mut self, state: VaultState) -> Result<(), StoreFault>;

    /// The `PUT` a phone makes to a presigned target. `attested` is false for
    /// the case R2 really produces: a client that did not send a checksum
    /// header, so the store has bytes and attests nothing.
    async fn upload(
        &mut self,
        vault: VaultId,
        name: ObjectName,
        bytes: Vec<u8>,
        attested: bool,
    ) -> Result<(), StoreFault>;

    /// Flip a stored object's bits, for the scrub.
    async fn corrupt(&mut self, vault: VaultId, name: ObjectName) -> Result<(), StoreFault>;

    /// Every byte the object store holds. The canary's first window.
    async fn stored_bytes(&self) -> Result<Vec<Vec<u8>>, StoreFault>;

    /// Everything the state store holds, rendered however the adapter renders
    /// it — a `Debug` dump, a row dump, a serialised store. The
    /// canary's second window, and the reason it is a `String` is that the
    /// canary asks only one question of it: does a plaintext appear in here?
    async fn state_text(&self) -> Result<String, StoreFault>;

    /// **THE BODY THIS ADAPTER PUTS ON THE WIRE FOR A REFUSAL**, as text.
    ///
    /// Not a rule and not storage: this is the adapter's own serializer, and it
    /// is here because it is the one place a deployment can silently lose
    /// something the rules produced. [`Refusal::code`] and
    /// [`Refusal::companions`] are `gateway-core`'s, and an adapter that
    /// rendered the code and dropped the companions would hand the phone a
    /// refusal it can display and not act on — which is what the standalone
    /// adapter was doing, found by the phone's own lane rather than by anything
    /// here.
    ///
    /// Text rather than a typed body because the two adapters do not share a
    /// serializer and are not required to: what the suite asks is that the name
    /// and the value both survive into whatever this adapter sends.
    async fn error_body(&self, refusal: &Refusal) -> Result<String, StoreFault>;
}

fn vault_id() -> VaultId {
    Key32::from_bytes([0x11; 32])
}

fn device(tag: u8) -> Key32 {
    Key32::from_bytes([tag; 32])
}

fn generation() -> Generation {
    Generation::parse("a1b2c3d4e5f60718293a4b5c6d7e8f90").expect("hex")
}

fn at(millis: i64) -> ServerTime {
    ServerTime::from_millis(millis)
}

const DAY: i64 = 86_400_000;
const START: i64 = 400 * DAY;

fn vault_state(plan: Plan) -> VaultState {
    VaultState {
        vault: vault_id(),
        account: Key32::from_bytes([0x22; 32]),
        lease: LeaseState::unclaimed(),
        head: None,
        append_only: false,
        plan,
    }
}

fn caller(epoch: u64, now: i64) -> Caller {
    Caller {
        vault: vault_id(),
        device: device(1),
        epoch,
        now: at(now),
    }
}

fn declaration(bytes: &[u8], kind: ObjectKind) -> Declaration {
    Declaration {
        name: ObjectName::of(bytes),
        checksum: AttestedChecksum::of(bytes),
        kind,
        padded_size: bytes.len() as u64,
    }
}

/// Put one object all the way through declare, upload and commit.
async fn land<H: Harness>(
    harness: &mut H,
    bytes: &[u8],
    kind: ObjectKind,
    head: ObjectName,
    prev_head: Option<ObjectName>,
    now: i64,
) -> Result<(), Fault> {
    let declaration = declaration(bytes, kind);
    harness
        .gateway()
        .declare(caller(1, now), core::slice::from_ref(&declaration))
        .await?;
    harness
        .upload(vault_id(), declaration.name, bytes.to_vec(), true)
        .await?;
    harness
        .gateway()
        .commit(
            caller(1, now),
            &CommitInput {
                generation: generation(),
                objects: vec![declaration.name],
                manifest_head: head,
                prev_head,
                first_txid: 1,
                last_txid: 2,
            },
        )
        .await?;
    Ok(())
}

/// Register a vault and take the lease at epoch 1.
async fn founded<H: Harness>(
    harness: &mut H,
    mode: ChecksumMode,
    policy: Policy,
    plan: Plan,
) -> Result<(), Fault> {
    harness.reset(mode, policy).await?;
    harness.register(vault_state(plan)).await?;
    harness.gateway().claim_lease(caller(1, START)).await?;
    Ok(())
}

/// Run every case.
///
/// The result is a [`Report`], never a panic: a Worker has no test harness to
/// catch one, and a suite that aborts on its first failure tells an adapter
/// author one thing per run.
pub async fn run<H: Harness>(harness: &mut H) -> Report {
    let mut report = Report::default();
    let quota = Plan::active(1_024 * 1_024 * 1_024);

    version_skew(&mut report);
    error_companions(harness, &mut report).await;
    checksum_modes(harness, &mut report, quota).await;
    presign_refusal(harness, &mut report, quota).await;
    head_race(harness, &mut report, quota).await;
    retention_abuse(harness, &mut report, quota).await;
    lease_refusals(harness, &mut report, quota).await;
    plan_and_quota(harness, &mut report).await;
    scrub_and_purge(harness, &mut report, quota).await;
    canary(harness, &mut report, quota).await;
    report
}

/// A REFUSAL REACHES THE PHONE WITH WHAT THE RULE PUT IN IT.
///
/// The code says *what* was refused and the companions say *which* — the epoch
/// that superseded this device and **when**, the head as it stands now, the
/// server's protocol range. A phone that gets `VAULT_MOVED` and no time can
/// freeze the vault and cannot tell the member how much is at stake, and a
/// shell that defaults the missing time draws a fabricated one.
///
/// This case exists because that is exactly what happened: the standalone
/// adapter's error body carried the code and the server clock and nothing else,
/// and it was found by the phone's client lane rather than by this suite. The
/// suite had no window onto an adapter's wire body at all, which is the hole —
/// [`Harness::error_body`] is that window, and this is what looks through it.
///
/// It asks only that the **name and the value both survive**. How an adapter
/// nests them is its own business; that it sends them is the protocol's.
async fn error_companions<H: Harness>(harness: &mut H, report: &mut Report) {
    let name = "errors/a-refusal-carries-its-companions-on-the-wire";
    let refusals = [
        Refusal::VaultMoved {
            current_epoch: 7,
            moved_at: at(START),
        },
        Refusal::VersionWindow {
            server: (1, 1),
            client: 9,
        },
        Refusal::HeadConflict {
            current: Some(ObjectName::of(b"the head as it stands")),
        },
        Refusal::LeaseStale {
            held: 3,
            claimed: 3,
        },
        Refusal::QuotaExceeded {
            quota_bytes: 1_024,
            used_bytes: 1_000,
            wanted_bytes: 2_048,
        },
    ];

    for refusal in &refusals {
        let body = match harness.error_body(refusal).await {
            Ok(body) => body,
            Err(fault) => {
                report.fail(
                    name,
                    format!("the adapter could not render {refusal:?}: {fault:?}"),
                );
                return;
            }
        };
        // The code first: a body that lost that lost everything.
        let code = format!("{:?}", refusal.code());
        if !body.contains(&code) && !body.contains(&code.to_ascii_uppercase()) {
            report.fail(
                name,
                format!("the body for {refusal:?} does not name its code {code}: {body}"),
            );
            return;
        }
        for (field, value) in refusal.companions().fields() {
            if !body.contains(value.as_str()) {
                report.fail(
                    name,
                    format!(
                        "the body for {refusal:?} dropped `{field}` = `{value}`. A phone \
                         reads a missing companion as malformed rather than defaulting it, \
                         because a defaulted value is a fabricated fact: {body}"
                    ),
                );
                return;
            }
        }
    }

    // AND THE ABSENT HEAD IS STILL AN ANSWER. A lost compare-and-set against an
    // empty vault must not be indistinguishable from an adapter that dropped
    // the companion, or the phone cannot tell "re-read from nothing" from "this
    // server is broken".
    let empty = Refusal::HeadConflict { current: None };
    match harness.error_body(&empty).await {
        Ok(body) => report.check(
            name,
            body.contains("head"),
            format!("a head conflict with no head names no head at all: {body}"),
        ),
        Err(fault) => report.fail(
            name,
            format!("the adapter could not render {empty:?}: {fault:?}"),
        ),
    }
}

/// VERSION SKEW BOTH WAYS. A self-hoster a year behind, and a phone nobody has
/// updated since.
fn version_skew(report: &mut Report) {
    let phone = Range::new(4, 6);
    let old_server = Range::new(1, 2);
    report.check(
        "version-skew/server-too-old-writes-nothing",
        version::negotiate(old_server, phone) == Skew::ServerTooOld,
        "a phone above the server's whole range must get the typed \
         server-needs-an-update state",
    );
    report.check(
        "version-skew/client-too-old",
        version::negotiate(phone, old_server) == Skew::ClientTooOld,
        "a phone below the server's minimum must be told it is the old one",
    );
    report.check(
        "version-skew/request-outside-the-range-is-refused",
        version::admit(Range::new(2, 4), 9).is_err() && version::admit(Range::new(2, 4), 3).is_ok(),
        "the server admits its own range and refuses outside it",
    );
}

/// BOTH CHECKSUM MODES, because B2 and MinIO differ on which headers they
/// attest and without both the adapters diverge on the one rule the whole
/// scheme rests on.
async fn checksum_modes<H: Harness>(harness: &mut H, report: &mut Report, plan: Plan) {
    for (mode, label) in [
        (ChecksumMode::Attest, "attest"),
        (ChecksumMode::ReadAndHash, "read-and-hash"),
    ] {
        let name: &'static str = if label == "attest" {
            "checksum/attest-mode-commits-verified-bytes"
        } else {
            "checksum/read-and-hash-mode-commits-verified-bytes"
        };
        if let Err(fault) = founded(harness, mode, Policy::default(), plan).await {
            report.fail(name, format!("setup failed: {fault:?}"));
            continue;
        }
        let bytes = b"sealed base range, mode one".to_vec();
        let head = ObjectName::of(b"manifest one");
        match land(harness, &bytes, ObjectKind::Base, head, None, START).await {
            Ok(()) => report.pass(name),
            Err(fault) => report.fail(name, format!("a good commit was refused: {fault:?}")),
        }
    }

    // R2 RECORDS THE ATTESTED CHECKSUM ONLY IF THE CLIENT SENT IT, so "no
    // checksum" must be a rejection and not a shrug. `checksum.rs` says which
    // checksum that is, and why it is the one thing here that is not BLAKE3.
    for mode in [ChecksumMode::Attest, ChecksumMode::ReadAndHash] {
        let name = "checksum/no-attestation-is-a-rejection";
        if founded(harness, mode, Policy::default(), plan)
            .await
            .is_err()
        {
            report.fail(name, "setup failed");
            return;
        }
        let bytes = b"bytes uploaded with no checksum header".to_vec();
        let declared = declaration(&bytes, ObjectKind::Segment);
        if harness
            .gateway()
            .declare(caller(1, START), core::slice::from_ref(&declared))
            .await
            .is_err()
        {
            report.fail(name, "the declaration itself was refused");
            return;
        }
        if harness
            .upload(vault_id(), declared.name, bytes.clone(), false)
            .await
            .is_err()
        {
            report.fail(name, "the upload failed");
            return;
        }
        let outcome = harness
            .gateway()
            .commit(
                caller(1, START),
                &CommitInput {
                    generation: generation(),
                    objects: vec![declared.name],
                    manifest_head: ObjectName::of(b"manifest two"),
                    prev_head: None,
                    first_txid: 1,
                    last_txid: 1,
                },
            )
            .await;
        let refused = matches!(
            outcome,
            Err(Fault::Refused(Refusal::Checksum(
                crate::checksum::ChecksumFault::Missing
            )))
        );
        if !refused {
            report.fail(
                name,
                format!("a commit with no attested checksum was not refused: {outcome:?}"),
            );
            return;
        }
    }
    report.pass("checksum/no-attestation-is-a-rejection");

    // The half only read-and-hash can see.
    let name = "checksum/read-and-hash-catches-bytes-that-do-not-hash-to-their-name";
    if founded(harness, ChecksumMode::ReadAndHash, Policy::default(), plan)
        .await
        .is_err()
    {
        report.fail(name, "setup failed");
        return;
    }
    let honest = b"the bytes the phone actually sealed".to_vec();
    let lie = declaration(b"a name for entirely other bytes", ObjectKind::Blob);
    let declared = Declaration {
        checksum: AttestedChecksum::of(&honest),
        padded_size: honest.len() as u64,
        ..lie
    };
    if harness
        .gateway()
        .declare(caller(1, START), core::slice::from_ref(&declared))
        .await
        .is_err()
    {
        report.fail(name, "the declaration was refused");
        return;
    }
    let _ = harness
        .upload(vault_id(), declared.name, honest, true)
        .await;
    let outcome = harness
        .gateway()
        .commit(
            caller(1, START),
            &CommitInput {
                generation: generation(),
                objects: vec![declared.name],
                manifest_head: ObjectName::of(b"manifest three"),
                prev_head: None,
                first_txid: 1,
                last_txid: 1,
            },
        )
        .await;
    report.check(
        name,
        matches!(
            outcome,
            Err(Fault::Refused(Refusal::Checksum(
                crate::checksum::ChecksumFault::NameMismatch
            )))
        ),
        format!("bytes that do not hash to their name committed: {outcome:?}"),
    );
}

/// REFUSE TO PRESIGN A COMMITTED NAME. Storage is write-once and a name is the
/// hash of its bytes.
async fn presign_refusal<H: Harness>(harness: &mut H, report: &mut Report, plan: Plan) {
    let name = "upload/a-committed-name-is-never-presigned";
    if founded(harness, ChecksumMode::Attest, Policy::default(), plan)
        .await
        .is_err()
    {
        report.fail(name, "setup failed");
        return;
    }
    let bytes = b"a pack of thumbnails".to_vec();
    let head = ObjectName::of(b"manifest four");
    if let Err(fault) = land(harness, &bytes, ObjectKind::Pack, head, None, START).await {
        report.fail(name, format!("setup commit failed: {fault:?}"));
        return;
    }
    let declared = declaration(&bytes, ObjectKind::Pack);
    let targets: Result<Vec<UploadTarget>, Fault> = harness
        .gateway()
        .declare(caller(1, START), core::slice::from_ref(&declared))
        .await;
    match targets {
        Ok(targets) => report.check(
            name,
            targets.len() == 1 && targets[0].already_committed && targets[0].url.is_empty(),
            format!("a committed name was presigned: {targets:?}"),
        ),
        Err(fault) => report.fail(
            name,
            format!("re-declaring committed bytes errored: {fault:?}"),
        ),
    }

    // The binding: the same name with another checksum is refused outright.
    let swapped = Declaration {
        checksum: AttestedChecksum::of(b"quite different bytes"),
        ..declared
    };
    let outcome = harness
        .gateway()
        .declare(caller(1, START), core::slice::from_ref(&swapped))
        .await;
    report.check(
        "upload/a-name-cannot-be-re-declared-with-another-checksum",
        matches!(outcome, Err(Fault::Refused(Refusal::Checksum(_)))),
        format!("a name was re-bound to other bytes: {outcome:?}"),
    );
}

/// THE TWO-DEVICE MANIFEST-CAS RACE. Both phones hold the seed and both sign
/// validly (F1); exactly one wins, and the other is told.
async fn head_race<H: Harness>(harness: &mut H, report: &mut Report, plan: Plan) {
    let name = "commit/two-devices-racing-leave-exactly-one-winner";
    if founded(harness, ChecksumMode::Attest, Policy::default(), plan)
        .await
        .is_err()
    {
        report.fail(name, "setup failed");
        return;
    }
    let first_head = ObjectName::of(b"head one");
    if let Err(fault) = land(
        harness,
        b"base at head one",
        ObjectKind::Base,
        first_head,
        None,
        START,
    )
    .await
    {
        report.fail(name, format!("the first commit failed: {fault:?}"));
        return;
    }

    // Both devices read the same head, then both commit from it.
    let winner_head = ObjectName::of(b"head two");
    let loser_head = ObjectName::of(b"head two prime");
    let winner = land(
        harness,
        b"segment from device A",
        ObjectKind::Segment,
        winner_head,
        Some(first_head),
        START + 1_000,
    )
    .await;
    let loser = land(
        harness,
        b"segment from device B",
        ObjectKind::Segment,
        loser_head,
        Some(first_head),
        START + 2_000,
    )
    .await;

    let told = matches!(
        loser,
        Err(Fault::Refused(Refusal::HeadConflict { current })) if current == Some(winner_head)
    );
    report.check(
        name,
        winner.is_ok() && told,
        format!("winner {winner:?}, loser {loser:?} — the loser must be told the current head"),
    );

    // A writer that never read the head cannot move one that exists.
    let fresh = land(
        harness,
        b"segment from a fresh phone",
        ObjectKind::Segment,
        ObjectName::of(b"head three"),
        None,
        START + 3_000,
    )
    .await;
    report.check(
        "commit/a-writer-that-never-read-the-head-cannot-move-it",
        matches!(fresh, Err(Fault::Refused(Refusal::HeadConflict { .. }))),
        format!("a first-commit claim moved an existing head: {fresh:?}"),
    );
}

/// THE RETENTION-ABUSE RUN: 50 backdated empty generations plus delete
/// requests, and the floor, the size guard and the rate limit all hold.
async fn retention_abuse<H: Harness>(harness: &mut H, report: &mut Report, plan: Plan) {
    let name = "retention/fifty-empty-generations-cannot-push-a-real-base-out";
    if founded(harness, ChecksumMode::Attest, Policy::default(), plan)
        .await
        .is_err()
    {
        report.fail(name, "setup failed");
        return;
    }

    // A real base, a year ago by the gateway's own clock.
    let real_bytes = vec![0xA5_u8; 64 * 1024];
    let real_head = ObjectName::of(b"real base head");
    let long_ago = START - 300 * DAY;
    if let Err(fault) = land(
        harness,
        &real_bytes,
        ObjectKind::Base,
        real_head,
        None,
        long_ago,
    )
    .await
    {
        report.fail(name, format!("the real base failed to land: {fault:?}"));
        return;
    }

    // Fifty empty generations. THE CLIENT CANNOT BACKDATE THEM — there is no
    // field for a client timestamp anywhere in the object API, and the gateway
    // files each one at its own receipt time. That is the whole of F10's
    // defence and it is structural rather than a check.
    let mut previous = real_head;
    for index in 0..50_u32 {
        let bytes = format!("empty base {index}").into_bytes();
        let head = ObjectName::of(format!("empty head {index}").as_bytes());
        if let Err(fault) = land(
            harness,
            &bytes,
            ObjectKind::Base,
            head,
            Some(previous),
            START + i64::from(index),
        )
        .await
        {
            report.fail(name, format!("empty generation {index} failed: {fault:?}"));
            return;
        }
        previous = head;
    }

    // The size guard is tripped, so no client-directed base tombstone lands.
    let real_object = ObjectName::of(&real_bytes);
    let outcomes = harness
        .gateway()
        .delete(caller(1, START + 100), &[real_object], false)
        .await;
    match outcomes {
        Ok(outcomes) => report.check(
            name,
            outcomes.len() == 1
                && matches!(
                    outcomes[0].verdict,
                    Verdict::Refused(DeleteRefusal::SizeGuard | DeleteRefusal::RetentionFloor)
                ),
            format!("the real base was tombstoned under an abuse run: {outcomes:?}"),
        ),
        Err(fault) => report.fail(name, format!("the delete request errored: {fault:?}")),
    }

    // THE RATE LIMIT, on its own: at most one client-directed base tombstone
    // per vault per day, even in one batch.
    let rate = "retention/one-client-base-tombstone-per-vault-per-day";
    if founded(harness, ChecksumMode::Attest, Policy::default(), plan)
        .await
        .is_err()
    {
        report.fail(rate, "setup failed");
        return;
    }
    let mut names = Vec::new();
    let mut previous = None;
    // Same-sized bases, so the size guard sleeps and the rate limit is what is
    // under test; old enough that the floor does not hold them either.
    for index in 0..4_u32 {
        let bytes = vec![index as u8; 8 * 1024];
        let head = ObjectName::of(format!("rate head {index}").as_bytes());
        if let Err(fault) = land(
            harness,
            &bytes,
            ObjectKind::Base,
            head,
            previous,
            START - (300 - i64::from(index)) * DAY,
        )
        .await
        {
            report.fail(rate, format!("base {index} failed: {fault:?}"));
            return;
        }
        names.push(ObjectName::of(&bytes));
        previous = Some(head);
    }
    // One more, recent and the same size, so the floor has something newer to
    // keep and the four old ones are outside it.
    let recent = vec![0x5A_u8; 8 * 1024];
    let recent_head = ObjectName::of(b"rate head recent");
    if let Err(fault) = land(
        harness,
        &recent,
        ObjectKind::Base,
        recent_head,
        previous,
        START,
    )
    .await
    {
        report.fail(rate, format!("the recent base failed: {fault:?}"));
        return;
    }

    match harness
        .gateway()
        .delete(caller(1, START), &names, true)
        .await
    {
        Ok(outcomes) => {
            let allowed = outcomes
                .iter()
                .filter(|outcome| matches!(outcome.verdict, Verdict::Tombstone { .. }))
                .count();
            let limited = outcomes.iter().any(|outcome| {
                matches!(
                    outcome.verdict,
                    Verdict::Refused(DeleteRefusal::RateLimited { .. })
                )
            });
            report.check(
                rate,
                allowed <= 1 && limited,
                format!("{allowed} base tombstones landed in one batch: {outcomes:?}"),
            );
        }
        Err(fault) => report.fail(rate, format!("the batch errored: {fault:?}")),
    }
}

/// The lease's two different refusals, and the behaviour attached to one of
/// them.
async fn lease_refusals<H: Harness>(harness: &mut H, report: &mut Report, plan: Plan) {
    let name = "lease/a-superseded-device-is-told-the-vault-moved";
    if founded(harness, ChecksumMode::Attest, Policy::default(), plan)
        .await
        .is_err()
    {
        report.fail(name, "setup failed");
        return;
    }
    // A restore onto a new phone: a new device key at epoch + 1.
    let restored = Caller {
        device: device(2),
        epoch: 2,
        ..caller(2, START + DAY)
    };
    if let Err(fault) = harness.gateway().claim_lease(restored).await {
        report.fail(name, format!("the restore claim was refused: {fault:?}"));
        return;
    }

    let old_phone = harness
        .gateway()
        .declare(
            caller(1, START + DAY + 1),
            &[declaration(
                b"a write from the old phone",
                ObjectKind::Segment,
            )],
        )
        .await;
    report.check(
        name,
        matches!(old_phone, Err(Fault::Refused(Refusal::VaultMoved { .. }))),
        format!("the superseded phone got {old_phone:?}, not a moved-vault refusal"),
    );

    let stale_claim = harness
        .gateway()
        .claim_lease(Caller {
            device: device(3),
            epoch: 2,
            ..caller(2, START + 2 * DAY)
        })
        .await;
    report.check(
        "lease/an-equal-epoch-is-refused",
        matches!(stale_claim, Err(Fault::Refused(Refusal::LeaseStale { .. }))),
        format!("two devices held the same epoch: {stale_claim:?}"),
    );
}

/// A free tier without a bound is Sybil storage, and a lapsed plan is read-only
/// rather than deleted (F13).
async fn plan_and_quota<H: Harness>(harness: &mut H, report: &mut Report) {
    let name = "plan/a-quota-refuses-the-byte-that-crosses-it";
    if founded(
        harness,
        ChecksumMode::Attest,
        Policy::default(),
        Plan::active(1_024),
    )
    .await
    .is_err()
    {
        report.fail(name, "setup failed");
        return;
    }
    let outcome = harness
        .gateway()
        .declare(
            caller(1, START),
            &[declaration(&vec![0_u8; 2_048], ObjectKind::Blob)],
        )
        .await;
    report.check(
        name,
        matches!(outcome, Err(Fault::Refused(Refusal::QuotaExceeded { .. }))),
        format!("a declaration above the quota was accepted: {outcome:?}"),
    );

    let lapsed = "plan/a-lapsed-plan-reads-but-writes-nothing-and-deletes-nothing";
    let plan = Plan {
        state: plan::State::Lapsed,
        ..Plan::active(1_024 * 1_024)
    };
    if founded(harness, ChecksumMode::Attest, Policy::default(), plan)
        .await
        .is_err()
    {
        report.fail(lapsed, "setup failed");
        return;
    }
    let write = harness
        .gateway()
        .declare(
            caller(1, START),
            &[declaration(b"a write while lapsed", ObjectKind::Segment)],
        )
        .await;
    report.check(
        lapsed,
        matches!(write, Err(Fault::Refused(Refusal::PlanLapsed))),
        format!("a lapsed plan accepted a write: {write:?}"),
    );
}

/// The blind scrub, and the grace period before a purge.
async fn scrub_and_purge<H: Harness>(harness: &mut H, report: &mut Report, plan: Plan) {
    let name = "scrub/bit-rot-is-reported-without-any-key";
    let policy = Policy::default();
    if founded(harness, ChecksumMode::Attest, policy, plan)
        .await
        .is_err()
    {
        report.fail(name, "setup failed");
        return;
    }
    let bytes = b"a blob nobody here can open".to_vec();
    let head = ObjectName::of(b"scrub head");
    if let Err(fault) = land(harness, &bytes, ObjectKind::Blob, head, None, START).await {
        report.fail(name, format!("setup commit failed: {fault:?}"));
        return;
    }
    let object = ObjectName::of(&bytes);

    match harness.gateway().scrub(&vault_id()).await {
        Ok(clean) => {
            if !clean.is_clean() {
                report.fail(name, format!("a fresh store scrubbed dirty: {clean:?}"));
                return;
            }
        }
        Err(fault) => {
            report.fail(name, format!("the scrub errored: {fault:?}"));
            return;
        }
    }
    if harness.corrupt(vault_id(), object).await.is_err() {
        report.fail(name, "the harness could not corrupt an object");
        return;
    }
    match harness.gateway().scrub(&vault_id()).await {
        Ok(dirty) => report.check(
            name,
            dirty.corrupt == vec![object],
            format!("a flipped bit was not reported: {dirty:?}"),
        ),
        Err(fault) => report.fail(name, format!("the scrub errored: {fault:?}")),
    }

    // The grace period: a tombstone keeps its bytes until it lapses.
    let grace = "retention/a-tombstone-keeps-its-bytes-until-the-grace-period-ends";
    let outcomes = harness
        .gateway()
        .delete(caller(1, START), &[object], false)
        .await;
    let Ok(outcomes) = outcomes else {
        report.fail(grace, format!("the delete errored: {outcomes:?}"));
        return;
    };
    if !matches!(outcomes[0].verdict, Verdict::Tombstone { .. }) {
        report.fail(grace, format!("a blob was not tombstoned: {outcomes:?}"));
        return;
    }
    let early = harness.gateway().purge(&vault_id(), at(START)).await;
    let late = harness
        .gateway()
        .purge(
            &vault_id(),
            at(START) + policy.grace + Duration::from_millis(1),
        )
        .await;
    report.check(
        grace,
        matches!(&early, Ok(purged) if purged.is_empty())
            && matches!(&late, Ok(purged) if purged == &[object]),
        format!("early {early:?}, late {late:?}"),
    );
}

/// THE CANARY: no known plaintext value, blob byte or plaintext hash appears
/// anywhere in the store.
///
/// The suite plants a plaintext, derives a stand-in ciphertext from it that
/// shares no substring with it, and puts the ciphertext through the whole
/// object path. Then it reads both windows the harness opens — every stored
/// byte and the whole state dump — and asserts that neither the plaintext nor
/// its BLAKE3 appears in either, in raw bytes or in hex.
///
/// It is a *canary*, not a proof: what it can catch is a rule or an adapter
/// that copies something it was handed into somewhere it should not, which is
/// exactly how a blind store stops being blind.
async fn canary<H: Harness>(harness: &mut H, report: &mut Report, plan: Plan) {
    let name = "canary/no-plaintext-or-plaintext-hash-is-anywhere-in-the-store";
    if founded(harness, ChecksumMode::Attest, Policy::default(), plan)
        .await
        .is_err()
    {
        report.fail(name, "setup failed");
        return;
    }

    const PLAINTEXT: &[u8] = b"MILK EGGS AND A DOCTORS APPOINTMENT ON THURSDAY";
    let plaintext_hash = *blake3::hash(PLAINTEXT).as_bytes();
    // A stand-in seal: reversed and masked, so no run of the plaintext survives
    // into the ciphertext and a substring hit really means something leaked.
    let ciphertext: Vec<u8> = PLAINTEXT
        .iter()
        .rev()
        .map(|byte| byte ^ 0x5A)
        .chain(plaintext_hash.iter().map(|byte| byte ^ 0xA5))
        .collect();

    let head = ObjectName::of(b"canary head");
    if let Err(fault) = land(harness, &ciphertext, ObjectKind::Blob, head, None, START).await {
        report.fail(name, format!("the canary object failed to land: {fault:?}"));
        return;
    }

    let Ok(stored) = harness.stored_bytes().await else {
        report.fail(name, "the harness could not list stored bytes");
        return;
    };
    let Ok(state_text) = harness.state_text().await else {
        report.fail(name, "the harness could not dump its state");
        return;
    };

    let needles: [(&str, Vec<u8>); 2] = [
        ("the plaintext", PLAINTEXT.to_vec()),
        ("the plaintext hash", plaintext_hash.to_vec()),
    ];
    for (label, needle) in &needles {
        for blob in &stored {
            if contains(blob, needle) {
                report.fail(name, format!("{label} appears in a stored object"));
                return;
            }
        }
        if contains(state_text.as_bytes(), needle) {
            report.fail(name, format!("{label} appears in the gateway's state"));
            return;
        }
        if state_text.contains(&hex::encode(needle)) {
            report.fail(name, format!("{label} appears in the state as hex"));
            return;
        }
    }
    // And the store really did hold the ciphertext, so the check above was
    // asked of something rather than of nothing.
    if !stored.iter().any(|blob| blob == &ciphertext) {
        report.fail(name, "the canary object is not in the store at all");
        return;
    }
    report.pass(name);
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len().max(1))
        .any(|window| window == needle)
}
