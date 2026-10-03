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
//! `unclaimed`, and the scan then visits exactly those. Whatever the scan, **a
//! vault this phone already holds is never touched**: its directory already
//! has a `vault.db`, so it is not asked about, not laid down again under the
//! core that has it open, and not answered.
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
use centraid_vault::backup::ledger::Destination;
use centraid_vault::backup::naming::Name;
use centraid_vault::backup::restore::{RestoreError, Restored, fetch_and_assemble};
use centraid_vault::backup::store::StoreError;

use super::link::GatewayStore;
use super::pair::{self, ClaimAnswer};
use super::{Keyring, Plane, now_ms, plane_error};
use crate::error::{CoreError, Result};

/// Consecutive misses that end the scan: twenty, BIP-44's address gap limit.
/// A member would have to skip twenty vault indices in a row for it to be
/// wrong, and `centraid_identity::VaultMint` lets them skip none.
pub const GAP: u32 = 20;

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
    let scan = Scan {
        payload: &payload,
        cert_der: &cert_der,
        runtime,
    };

    // FIRST, EVERY VAULT IS FETCHED, LAID DOWN AND CHECKED — and no writer
    // epoch moves (#1047 M1). One that will not check refuses the restore,
    // and every vault already laid down goes with it.
    let mut staged: Vec<Staged> = Vec::new();
    let mut visit = |index: u32| -> Result<bool> {
        let keyring = centraid_identity::derive::restore_vault_keys(&seed, index)
            .map(Keyring::of)
            .map_err(|error| CoreError::InvalidRequest {
                detail: format!("index {index} will not derive: {error}"),
            });
        let found = keyring.and_then(|keyring| {
            // A VAULT THIS PHONE ALREADY HOLDS IS NEVER TOUCHED (R-1047-R6),
            // and for the gap it is a hit.
            if vault_dir(&root, &keyring).join("vault.db").exists() {
                return Ok(true);
            }
            scan.check(keyring, &root, index)
                .map(|checked| checked.map(|one| staged.push(one)).is_some())
        });
        found.inspect_err(|_| staged.iter().for_each(Staged::forget))
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

    // ONLY THEN, THE CLAIMS. A claim that fails after an earlier one landed
    // cannot take that one back, so the claimed vaults are answered and the
    // rest named.
    let mut vaults = Vec::new();
    let mut unclaimed = Vec::new();
    let mut first_refusal = None;
    for mut one in staged {
        match scan.claim(&mut one, before_claim) {
            Ok(restored) => vaults.push(restored),
            Err(error) => {
                one.forget();
                unclaimed.push(wire::UnclaimedVault {
                    index: one.index,
                    vault_id: one.keyring.vault_hex(),
                    reason: error.to_string(),
                });
                first_refusal.get_or_insert(error);
            }
        }
    }
    if vaults.is_empty()
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
    payload: &'a PairPayload,
    cert_der: &'a [u8],
    runtime: &'a tokio::runtime::Handle,
}

/// One vault fetched, laid down and checked, and not yet claimed.
struct Staged {
    keyring: Keyring,
    index: u32,
    /// The head this phone checked; the claim names it.
    head: WireName,
    /// When the gateway set it, on its clock.
    head_set_ms: i64,
    /// The writer epoch the gateway last reported; the claim is one above.
    epoch: u64,
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
/// stopped answering is `Unavailable`; anything else is a snapshot this phone
/// would not accept, `INTERNAL`.
fn restore_error(error: RestoreError, index: u32) -> CoreError {
    match error {
        RestoreError::Plane(PlaneError::Store(StoreError::Unreachable(reason))) => {
            CoreError::Unavailable {
                reason: format!("the gateway stopped answering: {reason}"),
            }
        }
        other => CoreError::Invariant {
            context: format!(
                "the snapshot of the vault at index {index} would not restore: {other}"
            ),
        },
    }
}

impl Scan<'_> {
    fn client(&self) -> Client {
        Client::trusting(self.payload.addrs.clone(), self.cert_der.to_vec())
    }

    /// Ask about one index, and fetch, lay down and check its snapshot when
    /// the gateway holds it. **No writer epoch moves here.** `Ok(None)` is a
    /// miss: a vault the gateway does not hold, or holds with no head yet —
    /// paired, never backed up, which is nothing to lay down.
    fn check(&self, keyring: Keyring, root: &Path, index: u32) -> Result<Option<Staged>> {
        let client = self.client();
        let Some(grant) = pair::read_grant(&client, &keyring, &self.payload.gw, self.runtime)?
        else {
            return Ok(None);
        };
        client.set_token(grant.token);
        let state = self
            .runtime
            .block_on(client.head_state(&keyring.vault_id()))
            .map_err(pair::pairing_error)?;
        let Some(head) = state.head else {
            return Ok(None);
        };
        let dir = vault_dir(root, &keyring);
        let made = (!dir.exists()).then(|| dir.clone());
        std::fs::create_dir_all(&dir).map_err(|error| CoreError::Invariant {
            context: format!("making {}: {error}", dir.display()),
        })?;
        let file = dir.join("vault.db");
        let store = GatewayStore::over(
            client,
            keyring.vault_id(),
            self.payload.gw.hex(),
            self.runtime,
        );
        match lay_down(&store, &keyring, &head.name, &file, index) {
            Ok(restored) => Ok(Some(Staged {
                keyring,
                index,
                head: head.name,
                head_set_ms: head.set_at_ms,
                epoch: state.epoch,
                file,
                made,
                store,
                restored,
            })),
            Err(error) => {
                if let Some(dir) = &made {
                    let _ = std::fs::remove_dir_all(dir);
                }
                Err(error)
            }
        }
    }

    /// Claim one checked vault at the head it checked, and adopt it.
    fn claim(
        &self,
        staged: &mut Staged,
        before_claim: &mut dyn FnMut(u32),
    ) -> Result<wire::RestoredVault> {
        for _ in 0..CLAIM_ATTEMPTS {
            before_claim(staged.index);
            match pair::try_claim(
                staged.store.client(),
                &staged.keyring,
                &self.payload.gw,
                staged.epoch.saturating_add(1),
                Some(staged.head),
                self.runtime,
            )? {
                ClaimAnswer::Claimed(paired) => return self.adopt(staged, &paired),
                ClaimAnswer::Conflict { epoch, head } => {
                    staged.epoch = epoch;
                    let Some(head) = head else {
                        return Err(CoreError::Invariant {
                            context: format!(
                                "the gateway's head for index {} went back to none",
                                staged.index
                            ),
                        });
                    };
                    if head != staged.head {
                        // THE HEAD MOVED BETWEEN THE CHECK AND THE CLAIM: the
                        // old phone backed up in that window, and nothing
                        // moved. Lay the new head down and check it first.
                        let view = self
                            .runtime
                            .block_on(staged.store.client().head(&staged.keyring.vault_id()))
                            .map_err(pair::pairing_error)?;
                        staged.restored = lay_down(
                            &staged.store,
                            &staged.keyring,
                            &view.name,
                            &staged.file,
                            staged.index,
                        )?;
                        staged.head = view.name;
                        staged.head_set_ms = view.set_at_ms;
                        staged.epoch = view.epoch;
                    }
                }
            }
        }
        Err(CoreError::GatewayRefused {
            reason: format!(
                "the gateway's head for index {} kept moving; restore again",
                staged.index
            ),
        })
    }

    /// The claim landed: keep the gateway and the restored head beside the
    /// file, bring every derivative back, and answer the vault.
    fn adopt(
        &self,
        staged: &Staged,
        paired: &centraid_gateway::rules::wire::Paired,
    ) -> Result<wire::RestoredVault> {
        let gateway_id = paired.gateway_id.hex();
        let plane = Plane::of(&staged.file);
        let ledger = plane.ledger()?;
        ledger.reset().map_err(plane_error)?;
        let now = now_ms();
        ledger
            .put_destination(&Destination {
                gateway_id: gateway_id.clone(),
                addrs: self.payload.addrs.clone(),
                cert_der: self.cert_der.to_vec(),
                token: paired.token.hex(),
                epoch: paired.epoch,
                label: pair::label_of(self.payload),
                paired_at_ms: now,
                last_seen_ms: Some(now),
                last_ack_ms: None,
            })
            .map_err(plane_error)?;
        // THE HEAD THIS PHONE NOW CONTINUES, as a snapshot it set: the first
        // pass's compare-and-set names it, and retention reads its manifest.
        let manifest = &staged.restored.manifest;
        let name = staged.restored.manifest_name;
        let json = manifest.to_json().map_err(plane_error)?;
        let json = String::from_utf8(json).map_err(|_| CoreError::Invariant {
            context: "the restored manifest is not UTF-8".to_owned(),
        })?;
        ledger
            .record_snapshot(&name, manifest.taken_at_ms, &json)
            .map_err(plane_error)?;
        ledger.ack_snapshot(&name, now).map_err(plane_error)?;
        ledger.set_head(&gateway_id, &name).map_err(plane_error)?;
        ledger
            .set_head_acked(&gateway_id, u64::try_from(staged.head_set_ms).unwrap_or(0))
            .map_err(plane_error)?;
        let mut held: Vec<(Name, u64)> = manifest
            .ranges
            .iter()
            .map(|range| (range.name, range.len))
            .collect();
        held.push((name, json.len() as u64));
        ledger
            .confirm_many(&held, &gateway_id, now)
            .map_err(plane_error)?;

        // THE GRID, WHOLE: every derivative, in fetch bundles. A gateway that
        // stops answering here does not undo a claim that landed; what did
        // not come back is fetched on demand like any original.
        let vault = Vault::open(&staged.file)?;
        let files = content_files(&vault).map_err(plane_error);
        vault.close()?;
        let files = files?;
        let derivatives: Vec<&ContentFile> =
            files.iter().filter(|file| file.variant.is_some()).collect();
        let bytes = centraid_blobs::ByteStore::open(staged.file.with_extension("bytes")).map_err(
            |error| CoreError::Invariant {
                context: format!("the restored vault's content store: {error}"),
            },
        )?;
        match super::fetch::fetch_all(&staged.store, &staged.keyring.backup, &derivatives, &bytes) {
            Ok(landed) => tracing::info!(
                landed,
                of = derivatives.len(),
                "a restore brought the derivatives back"
            ),
            Err(error) => tracing::warn!(%error, "a restore's derivatives did not all come back"),
        }

        Ok(wire::RestoredVault {
            vault_id: staged.keyring.vault_hex(),
            index: staged.index,
            path: staged.file.to_string_lossy().into_owned(),
            rows: manifest.census.values().sum(),
            safety_number: pair::safety_number(&staged.keyring, &self.payload.pin),
        })
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
            let vault = Vault::open(file).map_err(|error| CoreError::Invariant {
                context: format!("the restored vault at index {index} would not open: {error}"),
            })?;
            vault.close()?;
            Ok(restored)
        });
    if outcome.is_err() {
        discard(file);
    }
    outcome
}
