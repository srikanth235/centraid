//! **BRING EVERY VAULT BACK FROM 24 WORDS** (#1029 §5, W15-3).
//!
//! The whole input is the phrase — or the seed it becomes, for a phone the
//! platform's synchronised keychain handed the seed and no words (#1047,
//! Q-1047-18) — and F2 is held structurally: there is no vault id here, no
//! index, no key and no path on the lost phone. What this module does with it
//! is derive, dial, ask, and fetch.
//!
//! # HOW A PHONE LEARNS WHICH VAULTS EXIST, WITH NO ACCOUNT AND NO LISTING
//!
//! The [scope amendment of
//! 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795)
//! struck the account and its signed vault listing. What is left is that **a
//! vault's identity public key IS its id** (§0) and the laptop files everything
//! under that id — so a restoring phone does not need to be told which vaults
//! exist. It **derives candidates by index and asks the laptop about each
//! one**, gap-limited, and the laptop answers by holding the vault or not.
//!
//! That is better than the listing endpoint the brief allowed for, on two
//! counts, and this module takes the better one:
//!
//! 1. **It needs no new endpoint and no new authority.** A listing is a claim
//!    the laptop makes about what exists, which a phone would then have to
//!    check against keys it derived anyway — so the derivation is the authority
//!    either way, and the listing is a round trip that can only agree with it
//!    or lie.
//! 2. **The laptop learns nothing new.** A probe asks about a vault id the
//!    laptop already holds; a listing would make the laptop link one member's
//!    vaults to each other, which under the amendment nothing else does.
//!
//! **The probe is a read of the head** (`GET /v1/vaults/{vault}/head`): a
//! laptop that holds the vault answers with the lease's epoch and the head,
//! and one that does not refuses as `UNKNOWN_VAULT`. The phone fetches that
//! generation, lays it down and checks it — `integrity_check` and the census —
//! and **only then** certifies at `epoch + 1` and claims the lease (F3). The
//! old phone's next put then gets `VAULT_MOVED` and freezes (F1, §1), which is
//! not a side effect of restoring: it is what restoring means.
//!
//! **Claim last, never first** (#1047 R3). The probe used to BE the claim, so a
//! generation the new phone then refused had already moved the lease: the old
//! phone froze, and nothing was restored anywhere. A refusal now moves nothing.
//!
//! **Every vault checks before any lease moves** (#1047 M1). The scan fetches,
//! lays down and checks every index first, and claims only once all of them
//! passed: one damaged vault refuses the restore and leaves every lease — and
//! the new phone's directory — as it found them. A claim can still fail after
//! an earlier one landed (the laptop dropped, or refused); the claimed vaults
//! are then answered and adopted with the device secret, and each one that
//! was not is named in `RestoreResponse.unclaimed`, its file removed and its
//! lease still the old phone's. A claimed vault is never dropped.
//!
//! **The claim names the head it checked** (#1047 L1). If the old phone
//! committed between the read and the claim, the laptop refuses the claim as
//! `GATEWAY_HEAD_CONFLICT` and the lease stays put; the phone re-reads, lays
//! the new head down, checks it, and claims again. A new head that fails its
//! checks therefore moves nothing either — the claim used to land first and
//! the new head was checked after, with the lease already gone.
//!
//! # ONE CARRIER FOR EVERY INDEX
//!
//! Every index is asked of the same laptop, so the scan binds one dial-only
//! endpoint and keeps one connection, and each index is only a signer over it
//! (`link::carrier`). A carrier per index was twenty-one endpoints and
//! twenty-one hole-punches for a one-vault member — tens of seconds on a
//! phone for what is twenty-one small requests.
//!
//! # NEVER REUSE AN INDEX, AND NEVER SKIP ONE SILENTLY
//!
//! Indices are scanned upward from zero and the scan stops after [`GAP`]
//! consecutive misses — the same shape as a wallet's address gap limit, for the
//! same reason: a member who made vaults 0, 1 and 4 must get all three back,
//! and a scan that stopped at the first miss would hand them two and say
//! nothing. `RestoreResponse.gap_scanned` reports how far past the last hit it
//! looked, so "we looked" is checkable rather than promised.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_api_proto::core_v1::ErrorCode;
use centraid_gateway_client::ClientError;
use centraid_gateway_client::client::GatewayClient;
use centraid_gateway_client::transport::IrohTransport;
use centraid_identity::VaultKeys;
use centraid_vault::backup::{self, GenerationManifest};

use super::{Laptop, link};
use crate::error::{CoreError, Result};

/// Consecutive misses that end the scan.
///
/// Twenty, which is BIP-44's address gap limit — a number with a decade of
/// wallets behind it rather than one this repository invented. A member would
/// have to skip twenty vault indices in a row for it to be wrong, and nothing
/// in the product lets them skip even one:
/// [`centraid_identity::VaultMint`] hands out the next index and refuses to go
/// back.
pub const GAP: u32 = 20;

/// **Bring every vault back from 24 words.**
///
/// # Errors
///
/// [`CoreError::InvalidRequest`] when the phrase is not 24 valid BIP-39 words
/// with a good checksum — refused before anything is derived, because a
/// mistyped word derives a different identity in silence and the member would
/// be told their laptop holds nothing — or when the request carries a seed
/// that is not 64 bytes, or carries both ([`seed_of`]).
/// [`CoreError::Unavailable`] when no laptop can be reached at all.
/// [`CoreError::Invariant`] (`INTERNAL`) when any generation the laptop holds
/// would not open, restore, pass `integrity_check` or match its census — no
/// lease has moved and nothing is left on disk.
/// [`CoreError::GatewayRefused`] (`UNAUTHORIZED`) when the laptop answered and
/// would not grant a lease, and no claim landed at all. A refusal after some
/// claim landed is not an error: it is `RestoreResponse.unclaimed`.
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
/// The product calls [`run`], which observes nothing. This exists because the
/// window it opens — between the check and the claim, where the old phone can
/// still commit — cannot be timed from outside, and the rule that a head
/// moving in it moves no lease (#1047 L1) is one a test has to drive rather
/// than wait for.
///
/// # Errors
///
/// As [`run`].
pub fn run_observed(
    vault_file: &Path,
    request: &wire::RestoreRequest,
    runtime: &tokio::runtime::Handle,
    before_claim: &mut dyn FnMut(u32),
) -> Result<wire::RestoreResponse> {
    let seed = seed_of(request)?;

    let endpoint = match request.endpoint.as_deref() {
        Some(typed) => <[u8; 32]>::try_from(typed).map_err(|_| CoreError::InvalidRequest {
            detail: "a typed laptop id is 32 bytes".to_owned(),
        })?,
        // THE RESOLVER IS SOMEBODY ELSE'S UPTIME, and §5 says so: the typed id
        // is the path that must always work. A restore that could only proceed
        // through DNS would fail on the day the resolver is down or the network
        // is walled, which is a day a member is already having.
        None => resolve(&seed, runtime)?,
    };

    // ONE DEVICE KEY FOR THIS PHONE, CERTIFIED PER VAULT. A certificate names
    // the vault identity that issued it, so a phone holding three vaults holds
    // one secret and three certificates (W15-D3).
    let device_secret = centraid_identity::certificate::DeviceKey::generate()
        .map_err(|error| CoreError::Unavailable {
            reason: format!("this device could not mint a key: {error}"),
        })?
        .to_secret_bytes();

    let root = vault_file
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();

    // THE ONE CARRIER, shared by every index's client (the module header).
    let record = Laptop {
        gateway_endpoint: hex::encode(endpoint),
        relay_url: None,
        direct_addrs: request.direct_addrs.clone(),
        device_certificate: None,
        epoch: None,
        last_acked_at_ms: None,
    };
    let carrier = Arc::new(runtime.block_on(link::carrier(&record))?);
    let scan = Scan {
        record: &record,
        carrier: &carrier,
        device_secret: &device_secret,
        runtime,
    };

    // FIRST, EVERY VAULT IS FETCHED, LAID DOWN AND CHECKED — and no lease
    // moves (#1047 M1). One that will not check refuses the whole restore,
    // and every vault already laid down goes with it.
    let mut staged: Vec<Staged> = Vec::new();
    let mut misses = 0_u32;
    let mut index = 0_u32;
    let mut gap_scanned = 0_u32;
    while misses < GAP {
        let checked = centraid_identity::derive::restore_vault_keys(&seed, index)
            .map_err(|error| CoreError::InvalidRequest {
                detail: format!("index {index} will not derive: {error}"),
            })
            .and_then(|keys| runtime.block_on(scan.check(keys, &root, index)));
        match checked {
            Ok(Some(one)) => {
                staged.push(one);
                misses = 0;
                gap_scanned = 0;
            }
            Ok(None) => {
                misses += 1;
                gap_scanned += 1;
            }
            Err(error) => {
                staged.iter().for_each(Staged::forget);
                return Err(error);
            }
        }
        index += 1;
    }

    // ONLY THEN, THE CLAIMS. A claim that fails after an earlier one landed
    // cannot take that one back, so the claimed vaults are answered — never
    // dropped with the device secret that drains them — and the rest named.
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
                    vault_id: one.vault_hex(),
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
        // HANDED OVER EXACTLY ONCE (W15-D3). A restore ALWAYS mints: the lost
        // phone's key is lost, which is the point.
        device_secret: device_secret.to_vec(),
        unclaimed,
    })
}

/// THE WORDS OR THE SEED, AND EXACTLY ONE (#1047, Q-1047-18).
///
/// A phone that received the seed through the platform's synchronised keychain
/// holds no words; the seed is what the words become, so it restores exactly
/// what they would. Both at once is refused — two answers to "whose vaults" —
/// and neither is refused as a phrase that is not 24 words. No refusal quotes
/// a word or a byte of either.
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

/// Resolve the laptop through a vault's own published identity record.
fn resolve(seed: &centraid_identity::Seed, runtime: &tokio::runtime::Handle) -> Result<[u8; 32]> {
    let keys = centraid_identity::derive::restore_vault_keys(seed, 0).map_err(|error| {
        CoreError::InvalidRequest {
            detail: format!("the seed will not derive: {error}"),
        }
    })?;
    let discovery =
        centraid_identity::Discovery::new().map_err(|error| CoreError::Unavailable {
            reason: format!("this phone has no resolver: {error}"),
        })?;
    let located = runtime
        .block_on(discovery.locate_vault(
            &keys.identity.public(),
            &centraid_identity::ResolutionSource::Published,
        ))
        .map_err(|error| CoreError::Unavailable {
            reason: format!(
                "the resolver could not find your laptop ({error}); type its id from the laptop's \
                 own screen"
            ),
        })?;
    located
        .endpoint()
        .copied()
        .ok_or_else(|| CoreError::Unavailable {
            reason: "the record names no laptop; type its id from the laptop's own screen"
                .to_owned(),
        })
}

/// A client for one vault over the shared carrier.
type Client = GatewayClient<Arc<IrohTransport>>;

/// How many times one vault's claim is tried when the head or the epoch moved
/// under it. Each retry re-reads and, for a moved head, re-checks; a vault
/// still moving after this is being fought over, which is for the member to
/// see rather than for a loop to win.
const CLAIM_ATTEMPTS: u32 = 3;

/// What every index of one restore shares.
struct Scan<'a> {
    record: &'a Laptop,
    carrier: &'a Arc<IrohTransport>,
    device_secret: &'a [u8; 32],
    runtime: &'a tokio::runtime::Handle,
}

/// One vault fetched, laid down and checked, and not yet claimed.
struct Staged {
    keys: VaultKeys,
    index: u32,
    /// The head this phone checked. The claim names it.
    head: String,
    /// The lease epoch the laptop last reported. The claim is one above.
    epoch: u64,
    file: PathBuf,
    /// The vault's directory, when this restore made it — so a refusal
    /// removes it whole, object store and all (#1047 L7).
    made: Option<PathBuf>,
    restored: backup::restore::RestoredGeneration,
}

impl Staged {
    fn vault_hex(&self) -> String {
        hex::encode(self.keys.identity.public().to_bytes())
    }

    /// Leave nothing of this vault on the phone: the file and its sidecars,
    /// and the directory with its object store when this restore made it.
    fn forget(&self) {
        discard(&self.file);
        if let Some(dir) = &self.made {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

impl Scan<'_> {
    /// Probe one index, and fetch, lay down and check it when the laptop holds
    /// it. **No lease moves here.**
    ///
    /// `Ok(None)` is a **miss** — a vault this laptop does not hold, which is
    /// the ordinary answer for every index past the last one the member made.
    async fn check(&self, keys: VaultKeys, root: &Path, index: u32) -> Result<Option<Staged>> {
        let Some((epoch, head, mut client)) = self.probe(&keys).await? else {
            return Ok(None);
        };
        let dir = root.join(&hex::encode(keys.identity.public().to_bytes())[..16]);
        let made = (!dir.exists()).then(|| dir.clone());
        link::ensure_dir(&dir)?;
        let file = dir.join("vault.db");
        match lay_down(&mut client, &keys, &head, &file, index).await {
            Ok(restored) => Ok(Some(Staged {
                keys,
                index,
                head,
                epoch,
                file,
                made,
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

    /// Read one vault's head without claiming. `Ok(None)` for a vault the
    /// laptop does not hold, or holds with no head yet.
    async fn probe(&self, keys: &VaultKeys) -> Result<Option<(u64, String, Client)>> {
        // THE PROBE IS A READ. Any epoch signs a read; the certificate only
        // has to name this vault's identity, which is what makes the laptop
        // answer.
        let probe = link::Device::certify(self.device_secret, &keys.identity, 1);
        let mut client = client_for(self.carrier, &probe, link::vault_id_of(keys)).await?;
        let seen = match client.head(link::now_ms()).await {
            Ok(seen) => seen,
            Err(ClientError::Transport(inner)) => {
                return Err(CoreError::Unavailable {
                    reason: format!("your laptop did not answer: {inner}"),
                });
            }
            // EVERY REFUSAL IS A MISS. A laptop that does not hold this vault
            // answers `UNKNOWN_VAULT`, and an index the member never minted is
            // exactly that.
            Err(_) => return Ok(None),
        };
        // NO HEAD: paired, never backed up. Not a failure, and not a restore
        // either — there is nothing to lay down, and writing an empty file
        // would be a silently empty product.
        Ok(seen.head.map(|head| (seen.epoch, head, client)))
    }

    /// Claim one checked vault's lease at the head it checked, and adopt it.
    fn claim(
        &self,
        staged: &mut Staged,
        before_claim: &mut dyn FnMut(u32),
    ) -> Result<wire::RestoredVault> {
        for _ in 0..CLAIM_ATTEMPTS {
            before_claim(staged.index);
            // The next epoch above the one the laptop last reported (F3).
            let epoch = staged.epoch + 1;
            let device = link::Device::certify(self.device_secret, &staged.keys.identity, epoch);
            let vault = link::vault_id_of(&staged.keys);
            let answer = self.runtime.block_on(async {
                let mut claimant = client_for(self.carrier, &device, vault).await?;
                Ok::<_, CoreError>(
                    claimant
                        .claim_lease_at_head(&staged.head, link::now_ms())
                        .await,
                )
            })?;
            match answer {
                Ok(_) => return self.adopt(staged, &device, epoch),
                // ANOTHER CLAIM TOOK THE EPOCH. Claim above the one it names.
                Err(ClientError::LeaseStale { held, .. }) => staged.epoch = held,
                // THE HEAD MOVED BETWEEN THE CHECK AND THE CLAIM: the old
                // phone committed in that window, and the lease did not move.
                // Read again, and check the new head before claiming it.
                Err(ClientError::Refused {
                    code: ErrorCode::GatewayHeadConflict,
                    ..
                }) => self.runtime.block_on(self.recheck(staged))?,
                Err(ClientError::Transport(inner)) => {
                    return Err(CoreError::Unavailable {
                        reason: format!("your laptop did not answer: {inner}"),
                    });
                }
                // A laptop that answered and refused is `GatewayRefused`
                // (`UNAUTHORIZED`), not `Unavailable`: pair's rule (#1047 E5),
                // so the shell does not tell a member to wake a laptop that is
                // awake.
                Err(other) => {
                    return Err(CoreError::GatewayRefused {
                        reason: format!("the laptop refused this phone's lease: {other}"),
                    });
                }
            }
        }
        Err(CoreError::GatewayRefused {
            reason: format!(
                "the laptop's head for index {} kept moving; restore again",
                staged.index
            ),
        })
    }

    /// Re-read a vault whose head moved, and lay the new head down and check
    /// it. A new head that fails its checks refuses this vault with its lease
    /// where it was.
    async fn recheck(&self, staged: &mut Staged) -> Result<()> {
        let Some((epoch, head, mut client)) = self.probe(&staged.keys).await? else {
            return Err(CoreError::Invariant {
                context: format!(
                    "the laptop's head for index {} went back to none",
                    staged.index
                ),
            });
        };
        staged.epoch = epoch;
        if head != staged.head {
            staged.restored =
                lay_down(&mut client, &staged.keys, &head, &staged.file, staged.index).await?;
            staged.head = head;
        }
        Ok(())
    }

    /// The claim landed: keep the laptop and the certificate beside the file,
    /// so the first drain after a restore has somewhere to send bytes and a
    /// lease it already holds, and answer the vault.
    fn adopt(
        &self,
        staged: &Staged,
        device: &link::Device,
        epoch: u64,
    ) -> Result<wire::RestoredVault> {
        Laptop {
            device_certificate: Some(device.certificate_hex()),
            epoch: Some(epoch),
            ..self.record.clone()
        }
        .write(&staged.file)?;
        // THE HEAD THIS PHONE NOW CONTINUES, KEPT where a drain reads it, so
        // the first drain appends to the generation it restored rather than
        // founding a new one with no previous head — which the laptop, holding
        // this head, refuses as a head conflict.
        let keys = keys_for(&staged.keys);
        let home = super::open_home(&staged.file)?;
        let store = home.objects().map_err(|error| CoreError::Invariant {
            context: format!("opening this phone's object store: {error}"),
        })?;
        let sealed = {
            use centraid_vault::backup::store::BlobStore as _;
            store.get(&staged.head)
        }
        .map_err(|error| CoreError::Invariant {
            context: format!("reading the restored head: {error}"),
        })?;
        let manifest =
            GenerationManifest::open(&keys, &sealed).map_err(|error| CoreError::Invariant {
                context: format!("opening the restored head: {error}"),
            })?;
        // AND THE SPOOL CONTINUES THAT GENERATION at the txid restored. A
        // fresh spool mints a new generation at txid 0, so the first capture
        // cut a segment the restored generation's manifest could not carry.
        let spool = home.spool().map_err(|error| CoreError::Invariant {
            context: format!("opening this phone's spool: {error}"),
        })?;
        spool
            .record_cursor(&backup::SpoolCursor::at(
                manifest.generation,
                manifest.last_txid(),
            ))
            .map_err(|error| CoreError::Invariant {
                context: format!("recording the restored spool cursor: {error}"),
            })?;
        backup::ManifestHead {
            vault_id: keys.vault_id_hex(),
            manifest: staged.head.clone(),
            generation: manifest.generation,
            last_txid: manifest.last_txid(),
        }
        .write(&home.head_path())
        .map_err(|error| CoreError::Invariant {
            context: format!("writing the restored head: {error}"),
        })?;

        let rows: i64 = staged.restored.census.iter().map(|(_, rows)| *rows).sum();
        let endpoint: [u8; 32] = hex::decode(&self.record.gateway_endpoint)
            .ok()
            .and_then(|raw| raw.try_into().ok())
            .unwrap_or([0; 32]);
        Ok(wire::RestoredVault {
            vault_id: staged.vault_hex(),
            index: staged.index,
            path: staged.file.to_string_lossy().into_owned(),
            txid: staged.restored.txid,
            rows,
            // THE NUMBER THE MEMBER READS ALOUD (W15-D5), per vault.
            safety_number: centraid_identity::pairing_safety_number(
                staged.keys.identity.public().as_bytes(),
                &endpoint,
            )
            .map_or_else(String::new, |number| number.grouped()),
        })
    }
}

/// One vault's client over the shared carrier, version agreed.
async fn client_for(
    carrier: &Arc<IrohTransport>,
    device: &link::Device,
    vault: centraid_gateway_core::ids::VaultId,
) -> Result<Client> {
    let mut client = GatewayClient::new(Arc::clone(carrier), device.signer(), vault);
    if let Err(error) = client.preflight(link::now_ms()).await {
        // THE LAPTOP ITSELF DID NOT ANSWER. Not a miss — a restore that cannot
        // proceed. Reporting it as "no vaults" would tell a member their words
        // were wrong when their network is.
        return Err(CoreError::Unavailable {
            reason: format!("your laptop did not answer: {error}"),
        });
    }
    Ok(client)
}

/// Remove a restored file and its sidecars. A refused restore leaves no vault
/// behind for a shell to open, and a stale `-wal` beside the next attempt's
/// file would be replayed into it.
fn discard(file: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let mut path = file.as_os_str().to_owned();
        path.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(path));
    }
}

/// Fetch the generation `head` names, lay it down at `file`, and check it:
/// `integrity_check` and the census (§2). **Any refusal removes the file**, so
/// a generation this phone would not accept is never left for a shell to open.
async fn lay_down(
    client: &mut Client,
    keys: &VaultKeys,
    head: &str,
    file: &Path,
    index: u32,
) -> Result<backup::restore::RestoredGeneration> {
    discard(file);
    let outcome = lay_down_unchecked(client, keys, head, file, index).await;
    if outcome.is_err() {
        discard(file);
    }
    outcome
}

async fn lay_down_unchecked(
    client: &mut Client,
    keys: &VaultKeys,
    head: &str,
    file: &Path,
    index: u32,
) -> Result<backup::restore::RestoredGeneration> {
    let home = super::open_home(file)?;
    let store = home.objects().map_err(|error| CoreError::Invariant {
        context: format!("opening this phone's object store: {error}"),
    })?;

    // THE MANIFEST FIRST, because it carries the dictionary every base range
    // and segment was sealed against (#1029 W13, finding 3). A build whose
    // trainer has moved still restores.
    let sealed = fetch(client, head).await?;
    let (manifest, dictionary) = GenerationManifest::open_with_dictionary(&keys_for(keys), &sealed)
        .map_err(|error| CoreError::Invariant {
            context: format!("the head manifest would not open: {error}"),
        })?;
    let objects = keys_for(keys).adopting(dictionary);
    keep(&store, &sealed)?;

    // EVERY OBJECT THE MANIFEST NAMES, and nothing else. A restore fetches what
    // it can verify, which is what the manifest lists.
    for name in manifest
        .base
        .iter()
        .map(|range| range.object_name.clone())
        .chain(manifest.segments.iter().map(|one| one.object.clone()))
    {
        let bytes = fetch(client, &name).await?;
        keep(&store, &bytes)?;
    }

    let restored = backup::restore::restore_generation(&objects, &manifest, &store, file, None)
        .map_err(|error| CoreError::Invariant {
            context: format!("the generation would not restore: {error}"),
        })?;

    // `integrity_check` AND THE CENSUS (§2). A perfect page tree over no rows
    // is a clean structural report and a total loss.
    let report = backup::restore_drill(file, None, None).map_err(|error| CoreError::Invariant {
        context: format!("the restore check would not run: {error}"),
    })?;
    if !report.is_clean() {
        return Err(CoreError::Invariant {
            context: format!(
                "the restored vault at index {index} is not clean: {}",
                report
                    .checks
                    .iter()
                    .filter(|check| !check.ok)
                    .map(|check| format!("{}: {}", check.name, check.detail))
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
        });
    }
    if let Err(reason) = restored
        .census_matches(file)
        .map_err(|error| CoreError::Invariant {
            context: format!("the census would not read: {error}"),
        })?
    {
        return Err(CoreError::Invariant {
            context: format!("the restored vault at index {index} has the wrong rows: {reason}"),
        });
    }
    Ok(restored)
}

fn keys_for(keys: &VaultKeys) -> backup::ObjectKeys {
    backup::ObjectKeys::new(keys.identity.public().to_bytes(), *keys.root.as_bytes())
}

async fn fetch(client: &mut Client, name: &str) -> Result<Vec<u8>> {
    let raw = hex::decode(name).map_err(|error| CoreError::Invariant {
        context: format!("an object name that is not hex: {error}"),
    })?;
    let raw: [u8; 32] = raw.try_into().map_err(|_| CoreError::Invariant {
        context: "an object name that is not 32 bytes".to_owned(),
    })?;
    client
        .get_object(
            &centraid_gateway_core::ids::Key32::from_bytes(raw),
            link::now_ms(),
        )
        .await
        .map_err(|error| CoreError::Unavailable {
            reason: format!("your laptop could not hand back {name}: {error}"),
        })
}

fn keep(store: &backup::FsBlobStore, bytes: &[u8]) -> Result<PathBuf> {
    use centraid_vault::backup::store::BlobStore as _;
    store
        .put(bytes)
        .map(PathBuf::from)
        .map_err(|error| CoreError::Invariant {
            context: format!("this phone's store would not keep an object: {error}"),
        })
}
