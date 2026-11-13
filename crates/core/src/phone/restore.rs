//! **BRING EVERY VAULT BACK FROM 24 WORDS** (#1029 §5, #1080, "Restore").
//!
//! The input is the phrase — or the seed it becomes, for a phone the
//! platform's synchronised keychain handed the seed and no words (#1047,
//! Q-1047-18) — and the pairing payload of the gateway to restore from. F2 is
//! held structurally: there is no vault id here, no key and no path on the
//! lost phone, and no index the shell chose.
//!
//! # HOW A PHONE LEARNS WHICH VAULTS EXIST, WITH NO ACCOUNT AND NO LISTING
//!
//! A vault's identity public key IS its id, and the gateway files everything
//! under it, so a restoring phone **derives candidates by index and asks the
//! gateway about each one**, gap-limited. The ask is a read-only grant: the
//! claim preimage at epoch 0, signed by the candidate's identity key. A gateway
//! that holds the vault grants a token that reads and never writes; one that
//! does not answers as it answers a stranger, and the index is a miss. The
//! gateway learns nothing it did not hold, and links no vault to another.
//!
//! # FETCH, CHECK, AND ONLY THEN CLAIM (#1047 R3, M1, L1)
//!
//! Under the read grant the phone reads the head, fetches the snapshot it
//! names and rebuilds the file — every range opened and checked against its
//! name, then `db_hash`, `integrity_check` and the census, and the file opened
//! through the forward-only ladder (`backup::restore`). **Every vault checks
//! before any writer epoch moves**: one that will not refuses the restore and
//! leaves every vault, and the new phone's directory, as it found them. Then
//! each vault is claimed at the writer epoch plus one, **naming the head it
//! checked**: if the old phone set a new head in between, the gateway refuses
//! the claim and nothing moves; the phone fetches and checks the new head and
//! claims again. The old phone's next write is then refused `MOVED`, and it
//! freezes — which is what restoring means.
//!
//! A claim can still fail after an earlier one landed (the gateway dropped, or
//! refused). The claimed vaults are answered and adopted; each one that was
//! not is named in `RestoreResponse.unclaimed`, its file removed and its
//! writer still the old phone. A claimed vault is never dropped.
//!
//! # WHAT A CLAIMED VAULT LEAVES BESIDE ITSELF
//!
//! The gateway, its certificate and the write token go in the restored vault's
//! own ledger, with the restored snapshot recorded as the head this phone now
//! continues: the first pass compares-and-sets from it. Every derivative comes
//! back in `fetch` bundles, so the grid is whole the moment the vault opens;
//! originals stay on the gateway until the rule or a tap brings one back
//! (`fetch_original`).
//!
//! # A VAULT THAT STAYED, ASKED FOR AGAIN (R-1047-R6)
//!
//! `RestoreRequest.indices` names the indices an earlier restore answered as
//! `unclaimed`, and the scan then visits exactly those.
//!
//! # THE SAME PHONE (#1173, item 22)
//!
//! **A vault this phone already holds is replaced, not skipped.** Its directory
//! has a `vault.db` that is an older copy of the head the gateway holds; the
//! restore lays the head down beside it, checks it and claims it like any other,
//! and then the held file, its WAL and its ledger give way to the restored
//! ones. There is no other phone to hand the vault to, so nothing is frozen and
//! no "moved to your other phone" is recorded: that marker is only for a real
//! move, where a claim from another directory supersedes a phone that is not
//! this one. A held vault the gateway holds no head for is left as it is, and so is one whose copy is
//! the **newer**: a copy that ran writes its backup lacks is answered as unclaimed, never
//! replaced. While the restored file is adopted the held one is set aside out of the name
//! `vault.db` (and put back if the adoption fails), so a crash never leaves an older file under
//! the name beside a ledger that already names the restored head.
//!
//! # A VAULT IS NAMED `vault.db` ONLY ONCE IT IS CLAIMED AND KEPT
//!
//! A vault is laid down and checked as `vault.db.restoring`, and renamed to
//! `vault.db` last, after its claim landed and its ledger records the
//! gateway, the token and the head. So a restore the phone did not live to
//! finish — killed between the check and the claim, or after the claim and
//! before the ledger — leaves nothing that reads as a held vault: the next
//! restore lays it down and claims it again, rather than skipping a vault no
//! gateway backs up while the old phone goes on as its writer.
//!
//! # NEVER REUSE AN INDEX, AND NEVER SKIP ONE SILENTLY
//!
//! Indices are scanned upward from zero and the scan stops after [`GAP`]
//! consecutive misses — a wallet's address gap limit, for the same reason: a
//! member who made vaults 0, 1 and 4 gets all three back.
//! `RestoreResponse.gap_scanned` reports how far past the last hit it looked.

use std::path::{Path, PathBuf};

use centraid_api_proto::core_v1 as wire;
use centraid_gateway::client::Client;
use centraid_gateway::rules::ids::Name as WireName;
use centraid_gateway::rules::payload::PairPayload;
use centraid_vault::Vault;
use centraid_vault::backup::PlaneError;
use centraid_vault::backup::files::{ContentFile, content_files};
use centraid_vault::backup::naming::Name;
use centraid_vault::backup::restore::{RestoreError, Restored, fetch_and_assemble};
use centraid_vault::backup::state::Gateway;
use centraid_vault::backup::store::StoreError;

use super::link::GatewayStore;
use super::pair::{self, ClaimAnswer};
use super::{Keyring, Plane, now_ms, plane_error};
use crate::error::{CoreError, Result};

/// What a vault is called while it is laid down, checked and claimed: never
/// `vault.db`, which is a vault this phone holds (the module header).
const RESTORING: &str = "vault.db.restoring";

/// What a vault this phone holds is called in its directory.
const HELD: &str = "vault.db";

/// Consecutive misses that end the scan: twenty, BIP-44's address gap limit.
/// A member would have to skip twenty vault indices in a row for it to be
/// wrong, and `centraid_identity::VaultMint` lets them skip none.
pub const GAP: u32 = 20;

/// How many times a claimed vault is adopted before it is answered as claimed and unfinished.
/// The claim is already on the gateway, so this is retried rather than given up on at once.
const ADOPT_ATTEMPTS: u32 = 2;

/// How many times one vault's claim is tried when the epoch or the head moved
/// under it. A vault still moving after this is being fought over, which is
/// for the member to see rather than for a loop to win.
const CLAIM_ATTEMPTS: u32 = 3;

/// **Bring every vault back.**
///
/// # Errors
/// [`CoreError::InvalidRequest`] for words that are not 24 valid BIP-39 words
/// (refused before anything is derived), a seed that is not 64 bytes, both, or
/// a missing or unreadable pairing payload. [`CoreError::Unavailable`] when the
/// gateway cannot be reached. [`CoreError::Invariant`] (`INTERNAL`) when any
/// snapshot the gateway holds would not open, rebuild or pass its checks — no
/// writer epoch has moved and nothing is left on disk.
/// [`CoreError::GatewayRefused`] (`UNAUTHORIZED`) when the gateway answered
/// and no claim landed at all. A refusal after some claim landed is not an
/// error: it is `RestoreResponse.unclaimed`.
pub fn run(
    vault_file: &Path,
    request: &wire::RestoreRequest,
    runtime: &tokio::runtime::Handle,
) -> Result<wire::RestoreResponse> {
    run_observed(vault_file, request, runtime, &mut |_| {})
}

/// [`run`], calling `before_claim` with a vault's index just before each of
/// its claims is sent.
///
/// The product calls [`run`]. This exists because the window it opens —
/// between the check and the claim, where the old phone can still set a head
/// — cannot be timed from outside, and the rule that a head moving in it moves
/// no writer epoch (#1047 L1) is one a test has to drive rather than wait for.
///
/// # Errors
/// As [`run`].
pub fn run_observed(
    vault_file: &Path,
    request: &wire::RestoreRequest,
    runtime: &tokio::runtime::Handle,
    before_claim: &mut dyn FnMut(u32),
) -> Result<wire::RestoreResponse> {
    run_controlled(
        vault_file,
        request,
        runtime,
        before_claim,
        &mut |_| {},
        None,
    )
}

/// [`run_observed`] that also calls `after_claim` once a claim has landed and before it is
/// adopted: the window in which a failure must not forget a vault the gateway already moved.
///
/// # Errors
/// As [`run`].
pub fn run_hooked(
    vault_file: &Path,
    request: &wire::RestoreRequest,
    runtime: &tokio::runtime::Handle,
    before_claim: &mut dyn FnMut(u32),
    after_claim: &mut dyn FnMut(u32),
) -> Result<wire::RestoreResponse> {
    run_controlled(
        vault_file,
        request,
        runtime,
        before_claim,
        after_claim,
        None,
    )
}

pub(crate) fn run_cancellable(
    vault_file: &Path,
    request: &wire::RestoreRequest,
    runtime: &tokio::runtime::Handle,
    cancellation: crate::handle::Cancellation,
) -> Result<wire::RestoreResponse> {
    run_controlled(
        vault_file,
        request,
        runtime,
        &mut |_| {},
        &mut |_| {},
        Some(cancellation),
    )
}

fn run_controlled(
    vault_file: &Path,
    request: &wire::RestoreRequest,
    runtime: &tokio::runtime::Handle,
    before_claim: &mut dyn FnMut(u32),
    after_claim: &mut dyn FnMut(u32),
    cancellation: Option<crate::handle::Cancellation>,
) -> Result<wire::RestoreResponse> {
    if let Some(stop) = &cancellation {
        stop.check()?;
    }
    let seed = seed_of(request)?;
    if request.payload.trim().is_empty() {
        return Err(CoreError::InvalidRequest {
            detail: "a restore names the gateway to restore from: scan its pairing code".to_owned(),
        });
    }
    // THE PAYLOAD'S DAY DOES NOT MATTER HERE: a restore spends no secret, and
    // the pin and the addresses it carries do not expire.
    let payload = pair::parse(&request.payload)?;
    let client = pair::first_contact(&payload, runtime)?;
    let cert_der = client.cert_der().ok_or_else(|| CoreError::Invariant {
        context: "the gateway answered and its certificate was not kept".to_owned(),
    })?;
    let root = vault_file
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    // A STOP IS WATCHED WHILE A CALL WAITS, and every question about an index (the read grant
    // included) is bounded by the client's own header and idle limits.
    client.set_stop(cancellation.clone().map(|held| {
        std::sync::Arc::new(move || held.check().is_err()) as centraid_gateway::client::Stop
    }));
    let scan = Scan {
        open: vault_file,
        payload: &payload,
        cert_der: &cert_der,
        client: &client,
        runtime,
        cancellation,
        use_older: request.use_older,
        minted: std::cell::RefCell::new(Vec::new()),
    };

    // FIRST, EVERY VAULT IS FETCHED, LAID DOWN AND CHECKED — and no writer
    // epoch moves (#1047 M1). One that will not check refuses the restore,
    // and every vault already laid down goes with it.
    let mut staged: Vec<Staged> = Vec::new();
    // A held copy that ran writes its backup lacks is left as it is, and answered as such.
    let mut newer: Vec<wire::UnclaimedVault> = Vec::new();
    // Vaults whose newest backup will not open and an older one does, offered and not restored.
    let mut offers: Vec<wire::OlderOffer> = Vec::new();
    let mut visit = |index: u32| -> Result<bool> {
        let keyring = centraid_identity::derive::restore_vault_keys(&seed, index)
            .map(Keyring::of)
            .map_err(|error| CoreError::InvalidRequest {
                detail: format!("index {index} will not derive: {error}"),
            });
        let found = keyring.and_then(|keyring| {
            scan.checkpoint()?;
            // A VAULT THIS PHONE ALREADY HOLDS IS A HIT FOR THE GAP, and when
            // the gateway holds a head for it too, the restore replaces the
            // copy (the module header, "the same phone").
            let held = vault_dir(&root, &keyring).join(HELD).exists();
            let vault_id = keyring.vault_hex();
            scan.check(keyring, &root, index)
                .map(|checked| match checked {
                    Checked::Miss => held,
                    Checked::Staged(one) => {
                        staged.push(*one);
                        true
                    }
                    Checked::Offer {
                        newest_ms,
                        offered_ms,
                    } => {
                        offers.push(wire::OlderOffer {
                            index,
                            vault_id,
                            newest_taken_at_ms: newest_ms,
                            offered_taken_at_ms: offered_ms,
                            device: pair::label_of(&payload),
                        });
                        true
                    }
                    Checked::HeldIsNewer => {
                        newer.push(wire::UnclaimedVault {
                            index,
                            vault_id,
                            reason: "this phone's copy is newer than its backup".to_owned(),
                            claimed: false,
                        });
                        true
                    }
                })
        });
        found
            .map_err(|error| scan.checkpoint().err().unwrap_or(error))
            .inspect_err(|_| staged.iter().for_each(Staged::forget))
    };
    let mut gap_scanned = 0_u32;
    if request.indices.is_empty() {
        let mut misses = 0_u32;
        let mut index = 0_u32;
        while misses < GAP {
            if visit(index)? {
                misses = 0;
                gap_scanned = 0;
            } else {
                misses += 1;
                gap_scanned += 1;
            }
            index += 1;
        }
    } else {
        let named: std::collections::BTreeSet<u32> = request.indices.iter().copied().collect();
        for index in named {
            visit(index)?;
        }
    }

    // AN OFFER UNANSWERED CLAIMS NOTHING: the member decides, and a second restore with
    // `use_older` takes the older backup. What was laid down for the other vaults goes.
    if !offers.is_empty() {
        staged.iter().for_each(Staged::forget);
        return Ok(wire::RestoreResponse {
            vaults: Vec::new(),
            gap_scanned,
            unclaimed: Vec::new(),
            older_offers: offers,
            tokens: Vec::new(),
            unproven_newest: Vec::new(),
        });
    }

    // ONLY THEN, THE CLAIMS. A claim that fails after an earlier one landed
    // cannot take that one back, so the claimed vaults are answered and the
    // rest named.
    let mut vaults = Vec::new();
    let left_alone = newer.len();
    let mut unclaimed = std::mem::take(&mut newer);
    let mut first_refusal = None;
    for mut one in staged {
        match scan.claim(&mut one, before_claim, after_claim) {
            Ok(restored) => vaults.push(restored),
            // THE CLAIM LANDED AND ADOPTING FAILED: the old phone is frozen already, so this
            // phone keeps the checked file and says the vault was claimed. A second restore
            // names it again and finishes it.
            Err(ClaimFailure::Adopt(error)) => {
                // NOT A REFUSAL: a claim that landed is answered, never returned as an error.
                unclaimed.push(wire::UnclaimedVault {
                    index: one.index,
                    vault_id: one.keyring.vault_hex(),
                    reason: error.to_string(),
                    claimed: true,
                });
            }
            Err(ClaimFailure::Claim(error)) => {
                let error = scan.checkpoint().err().unwrap_or(error);
                one.forget();
                unclaimed.push(wire::UnclaimedVault {
                    index: one.index,
                    vault_id: one.keyring.vault_hex(),
                    reason: error.to_string(),
                    claimed: false,
                });
                first_refusal.get_or_insert(error);
            }
        }
    }
    if vaults.is_empty()
        && left_alone == 0
        && let Some(error) = first_refusal
    {
        return Err(error);
    }
    Ok(wire::RestoreResponse {
        vaults,
        gap_scanned,
        // NOTHING IS MINTED (#1080): the gateway admits the restored phone by
        // the token its claim answered, which the restored vault's ledger
        // keeps, so the response carries no device secret (field 3 reserved).
        unclaimed,
        older_offers: Vec::new(),
        tokens: scan.minted.take(),
        unproven_newest: Vec::new(),
    })
}

/// THE WORDS OR THE SEED, AND EXACTLY ONE (#1047, Q-1047-18). No refusal
/// quotes a word or a byte of either.
fn seed_of(request: &wire::RestoreRequest) -> Result<centraid_identity::Seed> {
    match (request.phrase.trim(), request.seed.as_deref()) {
        ("", Some(bytes)) => {
            let raw: [u8; 64] = bytes.try_into().map_err(|_| CoreError::InvalidRequest {
                detail: format!("a seed is 64 bytes, and this one is {}", bytes.len()),
            })?;
            Ok(centraid_identity::Seed::from_bytes(raw))
        }
        (_, Some(_)) => Err(CoreError::InvalidRequest {
            detail: "a restore takes the 24 words or the seed, not both".to_owned(),
        }),
        (typed, None) => centraid_identity::RecoveryPhrase::parse(typed)
            .map(|phrase| phrase.seed())
            .map_err(|error| CoreError::InvalidRequest {
                detail: format!("those are not your 24 words: {error}"),
            }),
    }
}

/// Where a vault's directory is on this phone: the first 16 hex characters of
/// its identity key, under the directory the core was opened on.
fn vault_dir(root: &Path, keyring: &Keyring) -> PathBuf {
    root.join(&keyring.vault_hex()[..16])
}

/// Remove a restored file and everything the plane keeps beside it.
fn discard(file: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let mut path = file.as_os_str().to_owned();
        path.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(path));
    }
}

/// What every index of one restore shares.
struct Scan<'a> {
    /// The file the core running this restore has open, if it has one: never replaced.
    open: &'a Path,
    payload: &'a PairPayload,
    cert_der: &'a [u8],
    /// The scan's connection: every question about an index is a [`Client::sibling`] of it.
    client: &'a Client,
    runtime: &'a tokio::runtime::Handle,
    cancellation: Option<crate::handle::Cancellation>,
    /// The member said yes to an older backup (`RestoreRequest.use_older`).
    use_older: bool,
    /// The tokens this restore's claims minted, for the shell to keep (#1191, E12).
    minted: std::cell::RefCell<Vec<wire::GatewayToken>>,
}

/// What looking at one index came to.
enum Checked {
    /// The gateway holds nothing for it (or no head yet).
    Miss,
    /// Laid down and checked; the claim is next.
    Staged(Box<Staged>),
    /// This phone's held copy has writes the backup lacks, so it is not replaced.
    HeldIsNewer,
    /// The newest backup would not open and an older one does: offered, nothing laid down.
    Offer { newest_ms: i64, offered_ms: i64 },
}

/// Whether the copy at `held` has run writes that the restored file at `restored` has not.
/// A file that will not open is not newer: it is the damaged one.
fn held_is_newer(held: &Path, restored: &Path) -> bool {
    let writes = |file: &Path| -> Option<u64> {
        let vault = Vault::open(file).ok()?;
        let history = centraid_vault::backup::snapshot::history(&vault).ok();
        let _ = vault.close();
        history.map(|history| history.writes)
    };
    matches!((writes(held), writes(restored)), (Some(held), Some(head)) if held > head)
}

/// The held copy of a vault, moved out of the name `vault.db` for the whole of an adoption, so
/// that nothing reads as a held vault while the ledger already names the restored head (the
/// module header: the name is last). A failed adoption puts it back.
struct Aside {
    moved: Vec<(PathBuf, PathBuf)>,
}

impl Aside {
    const SUFFIXES: [&'static str; 3] = ["", "-wal", "-shm"];

    fn named(file: &Path, suffix: &str, tag: &str) -> PathBuf {
        let mut name = file.as_os_str().to_owned();
        name.push(tag);
        name.push(suffix);
        PathBuf::from(name)
    }

    fn take(kept: &Path) -> Result<Self> {
        let mut moved = Vec::new();
        for suffix in Self::SUFFIXES {
            // An earlier adoption's leftovers go first.
            let aside = Self::named(kept, suffix, ".replaced");
            let _ = std::fs::remove_file(&aside);
            let from = Self::named(kept, suffix, "");
            if from.exists() {
                std::fs::rename(&from, &aside).map_err(|error| CoreError::Invariant {
                    context: format!("setting {} aside: {error}", from.display()),
                })?;
                moved.push((from, aside));
            }
        }
        Ok(Self { moved })
    }

    /// The restored file is kept: the older copy goes.
    fn discard(self) {
        for (_, aside) in self.moved {
            let _ = std::fs::remove_file(aside);
        }
    }

    /// The adoption failed: the older copy is the vault again.
    fn put_back(self) {
        for (from, aside) in self.moved {
            let _ = std::fs::rename(aside, from);
        }
    }
}

/// Why a claim did not give the member a vault. The two are told apart because the first leaves
/// the gateway as it was and the second does not.
enum ClaimFailure {
    /// The claim did not land: the old phone is still the writer, and the file goes.
    Claim(CoreError),
    /// The claim landed and keeping the vault failed: the old phone is frozen and the checked
    /// file stays, so a second restore finishes the vault.
    Adopt(CoreError),
}

/// One vault fetched, laid down and checked, and not yet claimed.
struct Staged {
    keyring: Keyring,
    index: u32,
    /// The head this phone checked; the claim names it. When `older` is set it is the gateway's
    /// head, the one that would not open, which the claim is made against.
    head: WireName,
    /// Set when the newest backup would not open and the member took an older one: when that
    /// backup was taken, and the gateway's head is moved to it once the claim lands.
    older: Option<(WireName, i64)>,
    /// When the gateway set it, on its clock.
    head_set_ms: i64,
    /// The writer epoch the gateway last reported; the claim is one above.
    epoch: u64,
    /// Where it is laid down: `vault.db.restoring` until it is kept.
    file: PathBuf,
    /// The vault's directory, when this restore made it: a refusal removes it
    /// whole, its content store and ledger with it (#1047 L7).
    made: Option<PathBuf>,
    /// The client, under the read grant until the claim lands.
    store: GatewayStore,
    restored: Restored,
}

impl Staged {
    /// Leave nothing of this vault on the phone.
    fn forget(&self) {
        discard(&self.file);
        if let Some(dir) = &self.made {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// What a rebuild that would not finish is to the shell: a gateway that
/// stopped answering is `Unavailable`; a machine that is not the pinned
/// gateway is refused, as at pairing; anything else is a snapshot this phone
/// would not accept, `INTERNAL`.
fn restore_error(error: RestoreError, index: u32) -> CoreError {
    match error {
        RestoreError::Plane(PlaneError::Store(StoreError::Unreachable(reason))) => {
            CoreError::Unavailable {
                reason: format!("the gateway stopped answering: {reason}"),
            }
        }
        RestoreError::Plane(PlaneError::Store(StoreError::Untrusted(reason))) => {
            CoreError::GatewayRefused { reason }
        }
        // A NEWER BUILD'S BACKUP asks for an update, which is the one remedy a member has.
        RestoreError::NewerBuild { found, supported } => {
            CoreError::BackupFromNewerBuild { found, supported }
        }
        // EVERYTHING ELSE IS A SNAPSHOT THAT WILL NOT OPEN, said so in a sentence the member can
        // read: not "restart", which cannot help (#1188, B2, ruling 17).
        other => CoreError::BackupUnreadable {
            detail: format!("the snapshot of the vault at index {index}: {other}"),
        },
    }
}

impl Scan<'_> {
    fn checkpoint(&self) -> Result<()> {
        self.cancellation
            .as_ref()
            .map_or(Ok(()), crate::handle::Cancellation::check)
    }

    /// A client for one vault's questions: its own token, **the scan's one connection**. A scan
    /// asks about twenty indices past the last vault it found, and a handshake per question
    /// (#1188, item 17) was a TLS negotiation each.
    fn client(&self) -> Client {
        self.client.sibling()
    }

    /// Ask about one index, and fetch, lay down and check its snapshot when
    /// the gateway holds it. **No writer epoch moves here.** `Ok(None)` is a
    /// miss: a vault the gateway does not hold, or holds with no head yet —
    /// paired, never backed up, which is nothing to lay down.
    fn check(&self, keyring: Keyring, root: &Path, index: u32) -> Result<Checked> {
        let client = self.client();
        let Some(grant) = pair::read_grant(&client, &keyring, &self.payload.gw, self.runtime)?
        else {
            return Ok(Checked::Miss);
        };
        client.set_token(grant.token);
        let state = self
            .runtime
            .block_on(client.head_state(&keyring.vault_id(), &self.payload.gw))
            .map_err(pair::pairing_error)?;
        let Some(head) = state.head else {
            return Ok(Checked::Miss);
        };
        let dir = vault_dir(root, &keyring);
        let made = (!dir.exists()).then(|| dir.clone());
        std::fs::create_dir_all(&dir).map_err(|error| CoreError::Invariant {
            context: format!("making {}: {error}", dir.display()),
        })?;
        let file = dir.join(RESTORING);
        // A READ GRANT WRITES NOTHING: the store signs nothing until the
        // claim makes it this phone's, at the claim's epoch.
        let mut store = GatewayStore::over(
            client,
            keyring.vault.identity.signing(),
            self.payload.gw.hex(),
            state.epoch,
            0,
            self.runtime,
        )?;
        store.set_cancellation(self.cancellation.clone());
        let mut older = None;
        let laid = match lay_down(&store, &keyring, &head.name, &file, index) {
            Err(CoreError::BackupUnreadable { detail }) => {
                // THE NEWEST WILL NOT OPEN: the newest older one that does is the member's to
                // take or leave (#1188, B5). Anything but "will not open" (a gateway that
                // stopped answering, a newer build) is not a reason to go back in time.
                match self.newest_that_opens(&store, &keyring, &head, &file, index) {
                    Ok(Some((entry, restored))) => {
                        if !self.use_older {
                            discard(&file);
                            if let Some(dir) = &made {
                                let _ = std::fs::remove_dir_all(dir);
                            }
                            return Ok(Checked::Offer {
                                newest_ms: self.taken_at_of(&store, &head),
                                offered_ms: entry.1,
                            });
                        }
                        older = Some(entry);
                        Ok(restored)
                    }
                    Ok(None) => Err(CoreError::BackupUnreadable { detail }),
                    Err(error) => Err(error),
                }
            }
            other => other,
        };
        match laid {
            Ok(restored) => {
                // THE SAME PHONE: a copy this phone holds is replaced only when it is the older
                // one. One that ran writes the head lacks is the newer, and it is left alone.
                let held = dir.join(HELD);
                if held != self.open && held.exists() && held_is_newer(&held, &file) {
                    discard(&file);
                    return Ok(Checked::HeldIsNewer);
                }
                Ok(Checked::Staged(Box::new(Staged {
                    keyring,
                    index,
                    head_set_ms: older.as_ref().map_or(head.set_at_ms, |(_, taken)| *taken),
                    head: head.name,
                    older,
                    epoch: state.epoch,
                    file,
                    made,
                    store,
                    restored,
                })))
            }
            Err(error) => {
                if let Some(dir) = &made {
                    let _ = std::fs::remove_dir_all(dir);
                }
                Err(error)
            }
        }
    }

    /// When the gateway says `head` was taken, for the offer's "the newest was ...".
    fn taken_at_of(
        &self,
        store: &GatewayStore,
        head: &centraid_gateway::rules::wire::HeadView,
    ) -> i64 {
        use centraid_vault::backup::store::Store as _;
        let name = Name::from_bytes(*head.name.as_bytes());
        store
            .snapshots()
            .ok()
            .and_then(|entries| entries.into_iter().find(|entry| entry.name == name))
            .map_or(head.set_at_ms, |entry| {
                i64::try_from(entry.taken_at_ms).unwrap_or(i64::MAX)
            })
    }

    /// Lay down, newest first, each snapshot the gateway kept other than `head`, and answer the
    /// first that passes every check, with when it was taken. `None` when none does.
    fn newest_that_opens(
        &self,
        store: &GatewayStore,
        keyring: &Keyring,
        head: &centraid_gateway::rules::wire::HeadView,
        file: &Path,
        index: u32,
    ) -> Result<Option<((WireName, i64), Restored)>> {
        use centraid_vault::backup::store::Store as _;
        let mut kept = store.snapshots().map_err(|error| CoreError::Unavailable {
            reason: format!("the backup device did not list its backups: {error}"),
        })?;
        kept.sort_by_key(|entry| std::cmp::Reverse(entry.taken_at_ms));
        for entry in kept {
            self.checkpoint()?;
            let wire = WireName::from_bytes(*entry.name.as_bytes());
            if wire == head.name {
                continue;
            }
            match lay_down(store, keyring, &wire, file, index) {
                Ok(restored) => {
                    let taken = i64::try_from(entry.taken_at_ms).unwrap_or(i64::MAX);
                    return Ok(Some(((wire, taken), restored)));
                }
                Err(CoreError::BackupUnreadable { .. }) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(None)
    }

    /// Claim one checked vault at the head it checked, and adopt it.
    fn claim(
        &self,
        staged: &mut Staged,
        before_claim: &mut dyn FnMut(u32),
        after_claim: &mut dyn FnMut(u32),
    ) -> std::result::Result<wire::RestoredVault, ClaimFailure> {
        for _ in 0..CLAIM_ATTEMPTS {
            self.checkpoint().map_err(ClaimFailure::Claim)?;
            before_claim(staged.index);
            self.checkpoint().map_err(ClaimFailure::Claim)?;
            match pair::try_claim(
                staged.store.client(),
                &staged.keyring,
                &self.payload.gw,
                staged.epoch.saturating_add(1),
                Some(staged.head),
                self.runtime,
            )
            .map_err(ClaimFailure::Claim)?
            {
                ClaimAnswer::Claimed(paired) => {
                    after_claim(staged.index);
                    // THIS PHONE WRITES THERE NOW, at the claim's epoch and from
                    // generation zero (E3), under the token the claim minted.
                    staged.store.claimed(paired.token, paired.epoch);
                    self.minted.borrow_mut().push(wire::GatewayToken {
                        vault_id: staged.keyring.vault_hex(),
                        gateway_id: paired.gateway_id.hex(),
                        token: paired.token.hex(),
                    });
                    // Once writer authority moved, finish keeping the vault and
                    // its token before honoring a stop at the next vault.
                    staged.store.set_cancellation(None);
                    return self.adopt_retrying(staged, &paired);
                }
                ClaimAnswer::Conflict { epoch, head } => {
                    staged.epoch = epoch;
                    let Some(head) = head else {
                        return Err(ClaimFailure::Claim(CoreError::Invariant {
                            context: format!(
                                "the gateway's head for index {} went back to none",
                                staged.index
                            ),
                        }));
                    };
                    if head != staged.head {
                        // THE HEAD MOVED BETWEEN THE CHECK AND THE CLAIM: the
                        // old phone backed up in that window, and nothing
                        // moved. Lay the new head down and check it first.
                        // VERIFIED, as every head this phone acts on (E2).
                        let state = self
                            .runtime
                            .block_on(
                                staged
                                    .store
                                    .client()
                                    .head_state(&staged.keyring.vault_id(), &self.payload.gw),
                            )
                            .map_err(pair::pairing_error)
                            .map_err(ClaimFailure::Claim)?;
                        let Some(view) = state.head else {
                            return Err(ClaimFailure::Claim(CoreError::Invariant {
                                context: format!(
                                    "the gateway's head for index {} went back to none",
                                    staged.index
                                ),
                            }));
                        };
                        staged.restored = lay_down(
                            &staged.store,
                            &staged.keyring,
                            &view.name,
                            &staged.file,
                            staged.index,
                        )
                        .map_err(ClaimFailure::Claim)?;
                        staged.head = view.name;
                        staged.older = None;
                        staged.head_set_ms = view.set_at_ms;
                        staged.epoch = state.epoch;
                    }
                }
            }
        }
        Err(ClaimFailure::Claim(CoreError::GatewayRefused {
            reason: format!(
                "the gateway's head for index {} kept moving; restore again",
                staged.index
            ),
        }))
    }

    /// Adopt a vault whose claim landed, once more if the first try fails: the old phone is
    /// frozen already, so giving up costs the member a second restore.
    fn adopt_retrying(
        &self,
        staged: &Staged,
        paired: &centraid_gateway::rules::wire::Paired,
    ) -> std::result::Result<wire::RestoredVault, ClaimFailure> {
        let mut last = None;
        for _ in 0..ADOPT_ATTEMPTS {
            match self.adopt(staged, paired) {
                Ok(restored) => return Ok(restored),
                Err(error) => last = Some(error),
            }
        }
        Err(ClaimFailure::Adopt(last.unwrap_or(CoreError::Invariant {
            context: "adopting a claimed vault was not attempted".to_owned(),
        })))
    }

    /// The claim landed: keep the gateway and the restored head beside the
    /// file, bring every derivative back, name the file `vault.db`, and
    /// answer the vault. The name is last: until then nothing here reads as a
    /// held vault (the module header).
    fn adopt(
        &self,
        staged: &Staged,
        paired: &centraid_gateway::rules::wire::Paired,
    ) -> Result<wire::RestoredVault> {
        let kept = staged.file.with_file_name(HELD);
        // A copy this phone held gives way first, out of the name `vault.db`.
        let aside = Aside::take(&kept)?;
        match self.adopt_over(staged, paired, &kept) {
            Ok(restored) => {
                aside.discard();
                Ok(restored)
            }
            Err(error) => {
                aside.put_back();
                Err(error)
            }
        }
    }

    fn adopt_over(
        &self,
        staged: &Staged,
        paired: &centraid_gateway::rules::wire::Paired,
        kept: &Path,
    ) -> Result<wire::RestoredVault> {
        let gateway_id = paired.gateway_id.hex();
        // AN OLDER BACKUP TAKEN: the gateway's head is the one that would not open. This phone is
        // the writer now, so the head is moved to the backup it restored, and the first pass
        // continues from a head that opens.
        if let Some((older, taken)) = &staged.older {
            use centraid_vault::backup::store::Store as _;
            staged.store.client().set_token(paired.token);
            staged
                .store
                .set_head(
                    &Name::from_bytes(*older.as_bytes()),
                    Some(&Name::from_bytes(*staged.head.as_bytes())),
                    u64::try_from(*taken).unwrap_or(0),
                    staged.restored.manifest.writes,
                )
                .map_err(|error| CoreError::Unavailable {
                    reason: format!(
                        "the backup device did not take the older backup as its head: {error}"
                    ),
                })?;
        }
        let plane = Plane::of(kept);
        let ledger = plane.state()?;
        // THE SAME PHONE: a copy this one held is an older copy of this vault. What it owed is
        // not what the vault restored over it owes, so the outbox is emptied, and this gateway's
        // row starts over below (its moved mark, if it ever had one, is not the truth of the
        // vault restored over it).
        ledger.reset_for_restore(&[]).map_err(plane_error)?;
        let now = now_ms();
        // THE HEAD THIS PHONE NOW CONTINUES, as a snapshot it set: the first pass's
        // compare-and-set names it, and settle sees nothing owed.
        let manifest = &staged.restored.manifest;
        let name = staged.restored.manifest_name;
        let mut row = Gateway::paired(
            gateway_id.clone(),
            self.payload.addrs.clone(),
            self.cert_der.to_vec(),
            pair::label_of(self.payload),
            paired.epoch,
            now,
        );
        row.seen_ms = Some(now);
        row.ack_ms = Some(u64::try_from(staged.head_set_ms).unwrap_or(0));
        row.head = Some(name);
        row.head_ms = Some(manifest.taken_at_ms);
        row.writes = manifest.writes;
        row.snapshot = Some(name);
        row.snapshot_ms = Some(manifest.taken_at_ms);
        row.snapshot_writes = manifest.writes;
        ledger.put_gateway(&row).map_err(plane_error)?;

        // THE FILE FIRST: it takes the name `vault.db`, so a failure fetching the grid below can
        // never lose the vault itself.
        std::fs::rename(&staged.file, kept).map_err(|error| CoreError::Invariant {
            context: format!("keeping the restored vault as {}: {error}", kept.display()),
        })?;
        // THE GRID, WHOLE: every derivative, in fetch bundles. A gateway that
        // stops answering here does not undo a claim that landed; what did
        // not come back is fetched on demand like any original, and the answer
        // says how many landed of how many.
        let (landed, total) = self.bring_derivatives(staged, kept);
        Ok(wire::RestoredVault {
            vault_id: staged.keyring.vault_hex(),
            index: staged.index,
            path: kept.to_string_lossy().into_owned(),
            rows: manifest.census.values().sum(),
            safety_number: pair::safety_number(&staged.keyring, &self.payload.pin),
            derivatives_landed: landed,
            derivatives_total: total,
        })
    }

    /// Fetch every derivative the kept vault names; `(landed, of)`. A failure is logged and
    /// leaves the rest to on-demand fetches.
    fn bring_derivatives(&self, staged: &Staged, kept: &Path) -> (u32, u32) {
        let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
        let files: Result<Vec<ContentFile>> = (|| {
            let vault = Vault::open(kept)?;
            let files = content_files(&vault).map_err(plane_error);
            vault.close()?;
            files
        })();
        let files = match files {
            Ok(files) => files,
            Err(error) => {
                tracing::warn!(%error, "a restore could not list the derivatives to bring back");
                return (0, 0);
            }
        };
        let derivatives: Vec<&ContentFile> =
            files.iter().filter(|file| file.variant.is_some()).collect();
        let total = count(derivatives.len());
        let bytes = match centraid_blobs::ByteStore::open(kept.with_extension("bytes")) {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!(%error, "a restore could not open the content store");
                return (0, total);
            }
        };
        match super::fetch::fetch_all(&staged.store, &staged.keyring.backup, &derivatives, &bytes) {
            Ok(landed) => {
                tracing::info!(landed, of = total, "a restore brought the derivatives back");
                (count(landed), total)
            }
            Err(error) => {
                tracing::warn!(%error, "a restore's derivatives did not all come back");
                (0, total)
            }
        }
    }
}

/// Fetch the snapshot `head` names and rebuild the vault at `file`, every
/// check passed, then open it through the ladder once. **Any refusal removes
/// the file**, so a snapshot this phone would not accept is never left for a
/// shell to open.
fn lay_down(
    store: &GatewayStore,
    keyring: &Keyring,
    head: &WireName,
    file: &Path,
    index: u32,
) -> Result<Restored> {
    discard(file);
    let name = Name::from_bytes(*head.as_bytes());
    let outcome = fetch_and_assemble(store, &keyring.backup, &name, file)
        .map_err(|error| restore_error(error, index))
        .and_then(|restored| {
            // THE LADDER, ONCE, HERE: a snapshot an older build took is
            // migrated forward now, and one that will not open is refused
            // before any claim rather than found by the shell.
            let vault = Vault::open(file).map_err(|error| CoreError::BackupUnreadable {
                detail: format!("the restored vault at index {index} would not open: {error}"),
            })?;
            vault.close()?;
            Ok(restored)
        });
    if outcome.is_err() {
        discard(file);
    }
    outcome
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;
    use crate::{Core, CoreConfig};

    const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

    fn ask(handle: &crate::Handle, kind: wire::request::Kind) -> wire::response::Kind {
        handle
            .call(&wire::Request { kind: Some(kind) })
            .expect("the request succeeds")
            .kind
            .expect("an answer")
    }

    #[test]
    fn cancellation_before_claim_preserves_writer_and_after_claim_finishes_adoption() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("a runtime");
        let gateway_dir = tempfile::tempdir().expect("a directory");
        let gateway = runtime
            .block_on(centraid_gateway::server::harness::spawn(gateway_dir.path()))
            .expect("the gateway starts");
        let old_dir = tempfile::tempdir().expect("a directory");
        for index in 0..2 {
            let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
                .expect("words")
                .seed();
            let old = Core::open(
                CoreConfig::new(old_dir.path().join(format!("{index}.db"))).with_seed(seed, index),
            )
            .expect("the old phone opens");
            old.with_vault(|vault| Ok(vault.found("Test", "Owner")?))
                .expect("it founds");
            ask(
                &old,
                wire::request::Kind::PairPhone(wire::PairRequest {
                    payload: gateway.payload().to_json(),
                }),
            );
            ask(
                &old,
                wire::request::Kind::Drain(wire::DrainRequest {
                    wants_snapshot: true,
                    ..wire::DrainRequest::default()
                }),
            );
            old.close();
        }
        for after_claim in [false, true] {
            let restored_dir = tempfile::tempdir().expect("a directory");
            let mut config = CoreConfig::new(restored_dir.path().join("custody.db"));
            config.create = false;
            let front = Core::open(config).expect("the restore door opens");
            let cancellation = front.registered_cancellation(42);
            let request = wire::RestoreRequest {
                phrase: WORDS.to_owned(),
                payload: gateway.payload().to_json(),
                indices: vec![0, 1],
                ..wire::RestoreRequest::default()
            };
            let mut before = |index| {
                if !after_claim && index == 0 {
                    front.cancel(42).expect("cancels");
                }
            };
            let mut after = |index| {
                if after_claim && index == 0 {
                    front.cancel(42).expect("cancels");
                }
            };
            let result = run_controlled(
                front.path(),
                &request,
                runtime.handle(),
                &mut before,
                &mut after,
                Some(cancellation),
            );
            let pairings = gateway
                .shared()
                .rules(|rules| rules.pairings())
                .expect("pairings");
            let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
                .expect("words")
                .seed();
            let keyring = Keyring::derive(&seed, 0).expect("keys");
            let epoch = pairings
                .iter()
                .find(|pairing| pairing.vault.vault == keyring.vault_id())
                .expect("the first vault")
                .vault
                .writer_epoch;
            if after_claim {
                let restored = result.expect("a landed claim is kept and answered");
                assert_eq!(restored.vaults.len(), 1);
                assert_eq!(restored.unclaimed.len(), 1);
                assert_eq!(restored.unclaimed[0].index, 1);
                let file = PathBuf::from(&restored.vaults[0].path);
                let vault = Vault::open(&file).expect("the adopted vault opens");
                vault.close().expect("closes");
                let destinations = Plane::of(&file)
                    .state()
                    .expect("ledger")
                    .gateways()
                    .expect("destinations");
                assert_eq!(
                    destinations.len(),
                    1,
                    "the landed token survives cancellation"
                );
                assert_eq!(destinations[0].epoch, epoch);
                assert_eq!(epoch, 2);
            } else {
                assert!(matches!(
                    result,
                    Err(CoreError::Cancelled { request_id: 42 })
                ));
                assert_eq!(epoch, 1, "no claim crossed the cancellation boundary");
                assert!(
                    !vault_dir(restored_dir.path(), &keyring).exists(),
                    "staging was discarded"
                );
            }
            front.close();
        }
        runtime.block_on(gateway.shutdown());
    }
}

#[cfg(test)]
mod aside_tests {
    use super::*;

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .expect("a directory")
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_held_copy_leaves_the_name_for_the_whole_adoption_and_comes_back_if_it_fails() {
        let dir = tempfile::tempdir().expect("a directory");
        let kept = dir.path().join(HELD);
        for suffix in ["", "-wal", "-shm"] {
            std::fs::write(Aside::named(&kept, suffix, ""), b"older").expect("written");
        }
        // A leftover of an adoption that was killed.
        std::fs::write(dir.path().join("vault.db.replaced"), b"stale").expect("written");

        let aside = Aside::take(&kept).expect("set aside");
        assert!(!kept.exists(), "nothing reads as a held vault meanwhile");
        assert_eq!(
            std::fs::read(dir.path().join("vault.db.replaced")).expect("kept"),
            b"older"
        );
        aside.put_back();
        assert_eq!(
            files(dir.path()),
            ["vault.db", "vault.db-shm", "vault.db-wal"]
        );
        assert_eq!(std::fs::read(&kept).expect("back"), b"older");

        let aside = Aside::take(&kept).expect("set aside");
        aside.discard();
        assert!(
            files(dir.path()).is_empty(),
            "the older copy is gone once the restored one is kept"
        );
    }
}

#[cfg(test)]
mod error_tests {
    use super::*;

    /// **B2, ruling 17.** A backup a newer build made asks for an update; one that predates an
    /// in-place baseline edit (its rung-one digest is not this baseline's) or will not open is
    /// said in a plain sentence. Neither is `Internal`, whose remedy ("restart") cannot help.
    #[test]
    fn an_unreadable_or_newer_backup_is_said_in_a_sentence_that_helps() {
        let newer = restore_error(
            RestoreError::NewerBuild {
                found: 9,
                supported: 1,
            },
            0,
        );
        assert_eq!(
            newer.code(),
            centraid_api_proto::core_v1::ErrorCode::BackupFromNewerBuild
        );
        assert_eq!(
            newer.sentence(),
            "A newer Centraid made this backup. Update Centraid."
        );

        let early = restore_error(
            RestoreError::SchemaMismatch {
                found: "old".to_owned(),
                expected: "now".to_owned(),
            },
            0,
        );
        assert_eq!(
            early.code(),
            centraid_api_proto::core_v1::ErrorCode::BackupUnreadable
        );
        assert_eq!(
            early.sentence(),
            "This version of Centraid can't open this backup."
        );
        assert!(!early.sentence().contains("Restart"));
    }
}

#[cfg(test)]
mod held_tests {
    use super::*;
    use centraid_vault::commands::Registry;
    use centraid_vault::{Command, CommandStatus, Principal};

    /// A founded vault file with `notes` notes written, closed so its WAL is folded in.
    fn vault_with(path: &Path, notes: usize) {
        let vault = Vault::create(path).expect("founds");
        vault.found("Home", "Ada").expect("founds");
        let registry = Registry::with_system_commands().expect("a registry");
        for index in 0..notes {
            let outcome = vault
                .execute(
                    &registry,
                    &Principal::owner("phone"),
                    &Command::new(
                        "note.create",
                        serde_json::json!({ "title": format!("note {index}"), "body": "words" }),
                    ),
                )
                .expect("runs");
            assert_eq!(outcome.status, CommandStatus::Executed);
        }
        vault.close().expect("closes");
    }

    /// **A damaged held copy is never kept over a restore** (#1191, V21). The held copy has more
    /// writes than the restored file, so it is "newer"; with one of its pages really damaged it
    /// does not open, and it is not.
    #[test]
    fn a_held_copy_with_a_damaged_page_is_not_newer() {
        let dir = tempfile::tempdir().expect("a directory");
        let (held, restored) = (dir.path().join("held.db"), dir.path().join("restored.db"));
        vault_with(&held, 3);
        vault_with(&restored, 0);
        assert!(
            held_is_newer(&held, &restored),
            "the intact held copy is ahead"
        );

        let mut bytes = std::fs::read(&held).expect("reads");
        let page = usize::try_from(centraid_vault::file::PAGE_SIZE).expect("a size");
        for byte in &mut bytes[4 * page..5 * page] {
            *byte = 0xA5;
        }
        std::fs::write(&held, bytes).expect("writes");
        assert!(
            !held_is_newer(&held, &restored),
            "a damaged held copy answers not newer"
        );
    }
}
