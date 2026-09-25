//! **BRING EVERY VAULT BACK FROM 24 WORDS** (#1029 §5, W15-3).
//!
//! The whole input is the phrase, and F2 is held structurally: there is no
//! vault id here, no index, no key and no path on the lost phone. What this
//! module does with it is derive, dial, ask, and fetch.
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
//! **The probe is the lease claim**, which a restore has to make anyway (F3): a
//! laptop that holds the vault answers with the head, and one that does not
//! refuses. `ClientError::LeaseStale` carries the epoch the lost phone held,
//! which is the number a restore needs and cannot derive — so the phone
//! certifies again at `held + 1` and claims. **The old phone's next put then
//! gets `VAULT_MOVED` and freezes** (F1, §1), which is not a side effect of
//! restoring: it is what restoring means.
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

use centraid_api_proto::core_v1 as wire;
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
/// be told their laptop holds nothing.
/// [`CoreError::Unavailable`] when no laptop can be reached at all.
pub fn run(
    vault_file: &Path,
    request: &wire::RestoreRequest,
    runtime: &tokio::runtime::Handle,
) -> Result<wire::RestoreResponse> {
    let phrase =
        centraid_identity::RecoveryPhrase::parse(request.phrase.trim()).map_err(|error| {
            CoreError::InvalidRequest {
                detail: format!("those are not your 24 words: {error}"),
            }
        })?;
    let seed = phrase.seed();

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

    let mut vaults = Vec::new();
    let mut misses = 0_u32;
    let mut index = 0_u32;
    let mut gap_scanned = 0_u32;

    while misses < GAP {
        let keys =
            centraid_identity::derive::restore_vault_keys(&seed, index).map_err(|error| {
                CoreError::InvalidRequest {
                    detail: format!("index {index} will not derive: {error}"),
                }
            })?;
        match runtime.block_on(one_vault(
            &keys,
            &endpoint,
            &request.direct_addrs,
            &device_secret,
            &root,
            index,
        ))? {
            Some(restored) => {
                vaults.push(restored);
                misses = 0;
                gap_scanned = 0;
            }
            None => {
                misses += 1;
                gap_scanned += 1;
            }
        }
        index += 1;
    }

    Ok(wire::RestoreResponse {
        vaults,
        gap_scanned,
        // HANDED OVER EXACTLY ONCE (W15-D3). A restore ALWAYS mints: the lost
        // phone's key is lost, which is the point.
        device_secret: device_secret.to_vec(),
    })
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

/// Probe one index, and restore it when the laptop holds it.
///
/// `Ok(None)` is a **miss** — a vault this laptop does not hold, which is the
/// ordinary answer for every index past the last one the member made.
async fn one_vault(
    keys: &VaultKeys,
    endpoint: &[u8; 32],
    direct_addrs: &[String],
    device_secret: &[u8; 32],
    root: &Path,
    index: u32,
) -> Result<Option<wire::RestoredVault>> {
    let record = Laptop {
        gateway_endpoint: hex::encode(endpoint),
        relay_url: None,
        direct_addrs: direct_addrs.to_vec(),
        device_certificate: None,
        epoch: None,
        last_acked_at_ms: None,
    };
    let vault_id = link::vault_id_of(keys);

    // THE PROBE IS THE CLAIM. Epoch 1 first: a laptop holding this vault for a
    // phone that held its lease answers `LeaseStale` carrying the epoch, and
    // that number is the one thing a restoring phone cannot derive.
    let mut device = link::Device::certify(device_secret, &keys.identity, 1);
    let mut client = link::dial(&record, &device, vault_id).await?;
    if let Err(error) = client.preflight(link::now_ms()).await {
        // THE LAPTOP ITSELF DID NOT ANSWER. Not a miss — a restore that cannot
        // proceed. Reporting it as "no vaults" would tell a member their words
        // were wrong when their network is.
        return Err(CoreError::Unavailable {
            reason: format!("your laptop did not answer: {error}"),
        });
    }

    let (ack, epoch) = match client.claim_lease(link::now_ms()).await {
        Ok(ack) => (ack, 1),
        Err(ClientError::LeaseStale { held, .. }) => {
            // F3: A RESTORE TAKES THE NEXT EPOCH.
            device = link::Device::certify(device_secret, &keys.identity, held + 1);
            client = link::dial(&record, &device, vault_id).await?;
            let ack = client.claim_lease(link::now_ms()).await.map_err(|error| {
                CoreError::Unavailable {
                    reason: format!("the laptop refused this phone's lease: {error}"),
                }
            })?;
            (ack, held + 1)
        }
        Err(ClientError::Transport(inner)) => {
            return Err(CoreError::Unavailable {
                reason: format!("your laptop did not answer: {inner}"),
            });
        }
        // EVERY OTHER REFUSAL IS A MISS. A laptop that does not hold this vault
        // has no lease for a claim to be judged against, and an index the
        // member never minted is exactly that.
        Err(_) => return Ok(None),
    };

    let Some(head) = ack.head else {
        // THE LAPTOP HOLDS THE VAULT AND HAS NO HEAD: paired, never backed up.
        // Not a failure, and not a restore either — there is nothing to lay
        // down, and writing an empty file would be a silently empty product.
        return Ok(None);
    };

    let dir = root.join(&hex::encode(keys.identity.public().to_bytes())[..16]);
    link::ensure_dir(&dir)?;
    let file = dir.join("vault.db");
    let home = super::open_home(&file)?;
    let store = home.objects().map_err(|error| CoreError::Invariant {
        context: format!("opening this phone's object store: {error}"),
    })?;

    // THE MANIFEST FIRST, because it carries the dictionary every base range
    // and segment was sealed against (#1029 W13, finding 3). A build whose
    // trainer has moved still restores.
    let sealed = fetch(&mut client, &head).await?;
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
        let bytes = fetch(&mut client, &name).await?;
        keep(&store, &bytes)?;
    }

    let restored = backup::restore::restore_generation(&objects, &manifest, &store, &file, None)
        .map_err(|error| CoreError::Invariant {
            context: format!("the generation would not restore: {error}"),
        })?;

    // `integrity_check` AND THE CENSUS (§2). A perfect page tree over no rows
    // is a clean structural report and a total loss.
    let report =
        backup::restore_drill(&file, None, None, None).map_err(|error| CoreError::Invariant {
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
        .census_matches(&file)
        .map_err(|error| CoreError::Invariant {
            context: format!("the census would not read: {error}"),
        })?
    {
        return Err(CoreError::Invariant {
            context: format!("the restored vault at index {index} has the wrong rows: {reason}"),
        });
    }

    // THE LAPTOP AND THE CERTIFICATE, KEPT, so the first drain after a restore
    // has somewhere to send bytes and a lease it already holds.
    Laptop {
        device_certificate: Some(device.certificate_hex()),
        epoch: Some(epoch),
        ..record
    }
    .write(&file)?;

    let rows: i64 = restored.census.iter().map(|(_, rows)| *rows).sum();
    Ok(Some(wire::RestoredVault {
        vault_id: hex::encode(keys.identity.public().to_bytes()),
        index,
        path: file.to_string_lossy().into_owned(),
        txid: restored.txid,
        rows,
        // THE NUMBER THE MEMBER READS ALOUD (W15-D5), per vault.
        safety_number: super::laptop_identity(endpoint).map_or_else(String::new, |laptop| {
            centraid_identity::safety_number(&keys.identity.public(), &laptop).grouped()
        }),
    }))
}

fn keys_for(keys: &VaultKeys) -> backup::ObjectKeys {
    backup::ObjectKeys::new(keys.identity.public().to_bytes(), *keys.root.as_bytes())
}

async fn fetch(client: &mut GatewayClient<IrohTransport>, name: &str) -> Result<Vec<u8>> {
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
