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

use std::fmt::Debug;

use ed25519_dalek::SigningKey;

use crate::rules::bundle::Frame;
use crate::rules::claim::{sign_claim, sign_read};
use crate::rules::code::{Code, Refusal};
pub use crate::rules::engine::ScrubCounts;
use crate::rules::ids::{Digest, GatewayId, Name, Secret, Token, VaultId};
use crate::rules::limits::{GRACE_MS, MAX_NAMES, MAX_OBJECT_BYTES, PROTOCOL, SECRET_TTL_MS};
use crate::rules::range::ByteRange;
use crate::rules::wire::{
    BundleAnswer, ClaimBody, DeleteAnswer, HeadView, Info, ObjectEntry, PairKind, PairRequest,
    Paired, ReadBody, SetHead, SnapshotView,
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
    async fn snapshots(
        &mut self,
        token: &Token,
        vault: &VaultId,
    ) -> Result<Vec<SnapshotView>, Failure>;
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
        names: &[Name],
    ) -> Result<DeleteAnswer, Failure>;
    /// `POST /v2/v/{vault}/revoke`: the calling token revokes itself.
    async fn revoke(&mut self, token: &Token, vault: &VaultId) -> Result<(), Failure>;
}

/// Every case, by name, in the order [`run`] runs them. A target's test
/// asserts its report names exactly these, so a dropped case is a failure.
pub const CASES: [&str; 31] = [
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
];

/// Run every case. The result is a [`Report`], never a panic, so one run
/// names every failure.
pub async fn run<T: Target>(target: &mut T) -> Report {
    let mut report = Report::default();
    report.record(CASES[0], info(target).await);
    report.record(CASES[1], secret_admits_once(target).await);
    report.record(CASES[2], known_vault(target).await);
    report.record(CASES[3], dead_secret(target).await);
    report.record(CASES[4], malformed_pairing(target).await);
    report.record(CASES[5], tenancy(target).await);
    report.record(CASES[6], write_once(target).await);
    report.record(CASES[7], digest_mismatch(target).await);
    report.record(CASES[8], too_large(target).await);
    report.record(CASES[9], exists(target).await);
    report.record(CASES[10], get(target).await);
    report.record(CASES[11], listing(target).await);
    report.record(CASES[12], bundle(target).await);
    report.record(CASES[13], fetch(target).await);
    report.record(CASES[14], head(target).await);
    report.record(CASES[15], grace(target).await);
    report.record(CASES[16], head_in_use(target).await);
    report.record(CASES[17], exists_skips_tombstones(target).await);
    report.record(CASES[18], put_revives_tombstone(target).await);
    report.record(CASES[19], head_needs_held_manifest(target).await);
    report.record(CASES[20], delete_absent(target).await);
    report.record(CASES[21], listing_skips_tombstones(target).await);
    report.record(CASES[22], name_taken(target).await);
    report.record(CASES[23], scrub(target).await);
    report.record(CASES[24], claim_refusals(target).await);
    report.record(CASES[25], read_grant(target).await);
    report.record(CASES[26], fence(target).await);
    report.record(CASES[27], stale_claim(target).await);
    report.record(CASES[28], blindness_canary(target).await);
    report.record(CASES[29], credential_canary(target).await);
    report.record(CASES[30], revoked(target).await);
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
        target.pair(&read_request(&one, &target.gateway_id())).await,
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

fn secret_request(key: &SigningKey, secret: Secret) -> PairRequest {
    PairRequest {
        vault_id: vault_of(key),
        label: "phone".to_owned(),
        kind: PairKind::Secret,
        secret: Some(secret),
        claim: None,
        read: None,
    }
}

fn claim_request(
    key: &SigningKey,
    gateway: &GatewayId,
    epoch: u64,
    head_seen: Option<Name>,
) -> PairRequest {
    PairRequest {
        vault_id: vault_of(key),
        label: "restored phone".to_owned(),
        kind: PairKind::Claim,
        secret: None,
        claim: Some(ClaimBody {
            epoch,
            head_seen,
            signature: sign_claim(key, gateway, epoch, head_seen.as_ref()),
        }),
        read: None,
    }
}

fn read_request(key: &SigningKey, gateway: &GatewayId) -> PairRequest {
    PairRequest {
        vault_id: vault_of(key),
        label: "restoring phone".to_owned(),
        kind: PairKind::Read,
        secret: None,
        claim: None,
        read: Some(ReadBody {
            signature: sign_read(key, gateway),
        }),
    }
}

/// Pair `key`'s vault with a fresh secret.
async fn paired<T: Target>(target: &mut T, key: &SigningKey) -> Result<Paired, String> {
    let secret = target.mint_secret().await?;
    ok(
        target.pair(&secret_request(key, secret)).await,
        "pairing with a fresh secret",
    )
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
    let first = ok(
        target.pair(&secret_request(&key, secret)).await,
        "first use",
    )?;
    ensure(
        first.epoch == 1 && first.gateway_id == target.gateway_id(),
        || format!("a secret pairing answered {first:?}"),
    )?;
    refused(
        target.pair(&secret_request(&identity(2), secret)).await,
        Code::Unauthorized,
        "a spent secret, for another vault",
    )?;
    let no_head = refused(
        target.head(&first.token, &vault_of(&key)).await,
        Code::NoHead,
        "the new vault's head",
    )?;
    ensure(no_head == Refusal::NoHead { epoch: 1 }, || {
        format!("NO_HEAD must carry the writer epoch: {no_head:?}")
    })
}

async fn known_vault<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    paired(target, &key).await?;
    let secret = target.mint_secret().await?;
    refused(
        target.pair(&secret_request(&key, secret)).await,
        Code::VaultKnown,
        "a secret for a vault already paired",
    )?;
    let other = ok(
        target.pair(&secret_request(&identity(2), secret)).await,
        "the refused secret, for a new vault",
    )?;
    ensure(other.epoch == 1, || format!("{other:?}"))
}

async fn dead_secret<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let secret = target.mint_secret().await?;
    target.advance(SECRET_TTL_MS).await;
    refused(
        target.pair(&secret_request(&identity(1), secret)).await,
        Code::Unauthorized,
        "a secret a day old",
    )?;
    refused(
        target
            .pair(&secret_request(
                &identity(1),
                Secret::from_bytes([0x77; 16]),
            ))
            .await,
        Code::Unauthorized,
        "a secret nobody minted",
    )?;
    Ok(())
}

async fn malformed_pairing<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let secret = target.mint_secret().await?;
    let good = secret_request(&key, secret);
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
                read: read_request(&key, &target.gateway_id()).read,
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
    // None of those spent the secret.
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
    let set = |name: Name, prev: Option<Name>, taken_at_ms: i64| SetHead {
        name,
        prev,
        taken_at_ms,
    };
    let one = ok(
        target
            .set_head(&phone.token, &vault, &set(first.0, None, 100))
            .await,
        "the first head",
    )?;
    ensure(
        one.name == first.0 && one.epoch == 1 && one.taken_at_ms == 100,
        || format!("{one:?}"),
    )?;
    let conflict = refused(
        target
            .set_head(&phone.token, &vault, &set(second.0, None, 200))
            .await,
        Code::HeadConflict,
        "a writer that never saw the head",
    )?;
    ensure(
        conflict
            == Refusal::HeadConflict {
                epoch: 1,
                head: Some(one),
            },
        || format!("HEAD_CONFLICT must carry the head as it stands: {conflict:?}"),
    )?;
    let two = ok(
        target
            .set_head(&phone.token, &vault, &set(second.0, Some(first.0), 200))
            .await,
        "the second head",
    )?;
    let retried = ok(
        target
            .set_head(&phone.token, &vault, &set(second.0, Some(first.0), 200))
            .await,
        "the second head, retried after a lost answer",
    )?;
    ensure(retried == two, || format!("{retried:?} != {two:?}"))?;
    let unheld = object("never uploaded").0;
    refused(
        target
            .set_head(&phone.token, &vault, &set(unheld, Some(second.0), 300))
            .await,
        Code::NotFound,
        "a head naming a manifest the gateway does not hold",
    )?;
    let now = ok(target.head(&phone.token, &vault).await, "the head")?;
    ensure(now == two, || format!("{now:?}"))?;
    let snapshots = ok(target.snapshots(&phone.token, &vault).await, "snapshots")?;
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
                .set_head(
                    &phone.token,
                    &vault,
                    &SetHead {
                        name,
                        prev,
                        taken_at_ms: 1,
                    },
                )
                .await,
            "a head",
        )?;
    }
    let absent = object("absent").0;
    let answer = ok(
        target.delete(&phone.token, &vault, &[old.0, absent]).await,
        "delete",
    )?;
    ensure(
        answer.deleted == vec![old.0, absent] && answer.refused.is_empty(),
        || format!("{answer:?}"),
    )?;
    let snapshots = ok(target.snapshots(&phone.token, &vault).await, "snapshots")?;
    ensure(
        snapshots
            .iter()
            .map(|snapshot| snapshot.name)
            .collect::<Vec<_>>()
            == vec![new.0],
        || format!("a tombstoned manifest is still registered: {snapshots:?}"),
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
    let again = ok(target.delete(&phone.token, &vault, &[old.0]).await, "again")?;
    ensure(again.deleted == vec![old.0], || format!("{again:?}"))?;
    let early = target.purge().await?;
    ensure(early == 0, || format!("purged {early} inside the grace"))?;
    target.advance(GRACE_MS).await;
    let late = target.purge().await?;
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
            .set_head(
                &phone.token,
                &vault,
                &SetHead {
                    name: manifest.0,
                    prev: None,
                    taken_at_ms: 1,
                },
            )
            .await,
        "the head",
    )?;
    let answer = ok(
        target.delete(&phone.token, &vault, &[manifest.0]).await,
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
        target.delete(&phone.token, &vault, &[range.0]).await,
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

/// Tombstone `names` and expect every one deleted.
async fn tombstone<T: Target>(
    target: &mut T,
    phone: &Paired,
    vault: &VaultId,
    names: &[Name],
) -> Outcome {
    let answer = ok(target.delete(&phone.token, vault, names).await, "delete")?;
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
    target.advance(GRACE_MS).await;
    let purged = target.purge().await?;
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
            .set_head(
                &phone.token,
                &vault,
                &SetHead {
                    name: first.0,
                    prev: None,
                    taken_at_ms: 1,
                },
            )
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
                .set_head(
                    &phone.token,
                    &vault,
                    &SetHead {
                        name,
                        prev: Some(first.0),
                        taken_at_ms: 2,
                    },
                )
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
    target.advance(GRACE_MS).await;
    let swept = target.purge().await?;
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
    let mut forged = claim_request(&key, &gateway, 2, None);
    if let Some(claim) = forged.claim.as_mut() {
        claim.signature = sign_claim(&identity(9), &gateway, 2, None);
    }
    refused(
        target.pair(&forged).await,
        Code::Unauthorized,
        "a claim signed by another key",
    )?;
    let elsewhere = claim_request(&key, &GatewayId::from_bytes([0xee; 16]), 2, None);
    refused(
        target.pair(&elsewhere).await,
        Code::Unauthorized,
        "a claim signed for another gateway",
    )?;
    let skipped = refused(
        target.pair(&claim_request(&key, &gateway, 3, None)).await,
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
        target
            .pair(&claim_request(&identity(5), &gateway, 2, None))
            .await,
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
    let set = SetHead {
        name: manifest.0,
        prev: None,
        taken_at_ms: 5,
    };
    ok(
        target.set_head(&phone.token, &vault, &set).await,
        "the head",
    )?;
    let mut forged = read_request(&key, &gateway);
    forged.read = Some(ReadBody {
        signature: sign_read(&identity(9), &gateway),
    });
    refused(
        target.pair(&forged).await,
        Code::Unauthorized,
        "a read grant by another key",
    )?;
    let reader = ok(
        target.pair(&read_request(&key, &gateway)).await,
        "a read grant",
    )?;
    ensure(reader.epoch == 0, || {
        format!("a read grant is epoch 0: {reader:?}")
    })?;
    let seen = ok(target.head(&reader.token, &vault).await, "reading the head")?;
    ensure(seen.name == manifest.0 && seen.epoch == 1, || {
        format!("{seen:?}")
    })?;
    let bytes = ok(
        target.get(&reader.token, &vault, &manifest.0, None).await,
        "reading the manifest",
    )?;
    ensure(bytes == manifest.1, || "the manifest differs".to_owned())?;
    let blob = object("a write");
    let moved = Refusal::Moved { epoch: 1 };
    for (what, answer) in [
        (
            "a put",
            refused(
                target
                    .put(
                        &reader.token,
                        &vault,
                        &blob.0,
                        &Digest::of(&blob.1),
                        &blob.1,
                    )
                    .await,
                Code::Moved,
                "a read token's put",
            )?,
        ),
        (
            "a head",
            refused(
                target.set_head(&reader.token, &vault, &set).await,
                Code::Moved,
                "a read token's head",
            )?,
        ),
        (
            "a delete",
            refused(
                target.delete(&reader.token, &vault, &[manifest.0]).await,
                Code::Moved,
                "a read token's delete",
            )?,
        ),
    ] {
        ensure(answer == moved, || format!("{what}: {answer:?}"))?;
    }
    store(target, &phone, &vault, &object("the writer still writes")).await
}

async fn fence<T: Target>(target: &mut T) -> Outcome {
    target.reset().await?;
    let key = identity(1);
    let vault = vault_of(&key);
    let gateway = target.gateway_id();
    let first = paired(target, &key).await?;
    let manifest = object("fence manifest");
    store(target, &first, &vault, &manifest).await?;
    ok(
        target
            .set_head(
                &first.token,
                &vault,
                &SetHead {
                    name: manifest.0,
                    prev: None,
                    taken_at_ms: 10,
                },
            )
            .await,
        "phone one's head",
    )?;
    let second = ok(
        target
            .pair(&claim_request(&key, &gateway, 2, Some(manifest.0)))
            .await,
        "phone two's claim",
    )?;
    ensure(second.epoch == 2, || format!("{second:?}"))?;
    let moved = Refusal::Moved { epoch: 2 };
    let next = object("phone one's next manifest");
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
                &SetHead {
                    name: manifest.0,
                    prev: Some(manifest.0),
                    taken_at_ms: 11,
                },
            )
            .await,
        Code::Moved,
        "phone one's head",
    )?;
    let delete = refused(
        target.delete(&first.token, &vault, &[manifest.0]).await,
        Code::Moved,
        "phone one's delete",
    )?;
    ensure(put == moved && head == moved && delete == moved, || {
        format!("MOVED must carry the epoch that superseded it: {put:?} {head:?} {delete:?}")
    })?;
    let frozen = ok(target.head(&first.token, &vault).await, "phone one's read")?;
    ensure(frozen.name == manifest.0 && frozen.epoch == 2, || {
        format!("a superseded phone reads the head at the new epoch: {frozen:?}")
    })?;
    let bytes = ok(
        target.get(&first.token, &vault, &manifest.0, None).await,
        "phone one's get",
    )?;
    ensure(bytes == manifest.1, || {
        "phone one read other bytes".to_owned()
    })?;
    store(target, &second, &vault, &next).await?;
    ok(
        target
            .set_head(
                &second.token,
                &vault,
                &SetHead {
                    name: next.0,
                    prev: Some(manifest.0),
                    taken_at_ms: 12,
                },
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
    let gateway = target.gateway_id();
    let first = paired(target, &key).await?;
    let (old, new) = (object("stale old"), object("stale new"));
    store(target, &first, &vault, &old).await?;
    ok(
        target
            .set_head(
                &first.token,
                &vault,
                &SetHead {
                    name: old.0,
                    prev: None,
                    taken_at_ms: 1,
                },
            )
            .await,
        "the old head",
    )?;
    let second = ok(
        target
            .pair(&claim_request(&key, &gateway, 2, Some(old.0)))
            .await,
        "the claim",
    )?;
    store(target, &second, &vault, &new).await?;
    let current = ok(
        target
            .set_head(
                &second.token,
                &vault,
                &SetHead {
                    name: new.0,
                    prev: Some(old.0),
                    taken_at_ms: 2,
                },
            )
            .await,
        "the new head",
    )?;
    let stale = refused(
        target
            .pair(&claim_request(&key, &gateway, 3, Some(old.0)))
            .await,
        Code::HeadConflict,
        "a claim that checked a head that has moved",
    )?;
    ensure(
        stale
            == Refusal::HeadConflict {
                epoch: 2,
                head: Some(current),
            },
        || format!("HEAD_CONFLICT must carry the head as it stands: {stale:?}"),
    )?;
    store(target, &second, &vault, &object("the writer is unmoved")).await?;
    let third = ok(
        target
            .pair(&claim_request(&key, &gateway, 3, Some(new.0)))
            .await,
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
            .set_head(
                &phone.token,
                &vault,
                &SetHead {
                    name: stored[0].0,
                    prev: None,
                    taken_at_ms: 1,
                },
            )
            .await,
        "the head",
    )?;
    ok(
        target.delete(&phone.token, &vault, &[stored[2].0]).await,
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
    let phone = ok(target.pair(&secret_request(&key, secret)).await, "pairing")?;
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
