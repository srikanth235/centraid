//! ONE DRAIN PASS: seal what the vault has committed, and move it to the
//! laptop until the spool is empty or the budget is spent (#1029 §2, W15-2).
//!
//! # COMMIT GRANULARITY IS THE MANIFEST ENTRY, NOT THE GENERATION (W15-D4)
//!
//! The question this module turns on is what a deadline can possibly mean. A
//! gateway commit carries one `manifest_head`, one `prev_head` for the
//! compare-and-set and one txid range (`backup.proto`), so if a commit were
//! generation-scoped a deadline inside a generation could not move
//! `acked_txid` at all — a phone with a long spool and a 28-second background
//! window would upload for a week and be able to claim nothing.
//!
//! **It is not generation-scoped, and the code says so.** A manifest is a
//! *chain of small write-once objects* linked by `prev_manifest`, which is the
//! name of the previous manifest's ciphertext (`backup::manifest`'s header),
//! and `gateway-core`'s `commit` moves the head by
//! `compare_and_set_head(prev_head, manifest_head)` with nothing anywhere tying
//! a head to a generation boundary. An object already committed is a **no-op**
//! on a later commit (`already.push(*name)` in that same function), so a second
//! entry may re-list the base it shares with the first.
//!
//! So a pass commits **one manifest entry per batch of segments it fully
//! uploaded**, each entry chained to the last, each carrying the same base and
//! the segments **cumulatively**, and `acked_txid` is the last txid of the last
//! entry the gateway acked. **No proto change, and no watermark beside the
//! head** — the head is the one truth the F7 compare-and-set covers, and a
//! second one would be a truth it does not.
//!
//! The entry is cumulative rather than incremental for one reason: a restore
//! walks back from the head and opens **one** manifest, and
//! `backup::restore::restore_generation` lays that manifest's base and applies
//! that manifest's segments. An entry carrying only its own slice would restore
//! to a vault with the newest segments and none of the older ones — a file that
//! was never a state of the database. A manifest is small; correctness at
//! restore is not negotiable.
//!
//! # THE THREE LINES OF DEADLINE SEMANTICS
//!
//! 1. The budget starts when the pass starts and is checked **between
//!    entries**, never inside one: an entry is fully uploaded and committed, or
//!    it is not attempted. The spool never loses a sealed object either way.
//! 2. **A pass always commits at least one entry when there is one to commit**,
//!    however small the budget. A window smaller than one entry's upload that
//!    made no progress at all would make a phone on 28-second windows never
//!    finish, ever — the deadline is there to stop a pass, not to stop the
//!    product.
//! 3. `acked_txid` moves only on a gateway ack, and always to an entry
//!    boundary. `pending_bytes` is what the spool still holds when the pass
//!    stopped.
//!
//! # WHEN A NEW BASE IS TAKEN
//!
//! Only when there is no head at all. A drain **continues** the generation the
//! head names by appending entries; taking a fresh base is a retention decision
//! (F10 — the base is the retention unit, and "one per day" is judged by the
//! gateway's own receipt times) and belongs to `backup::BackupPolicy`, not to
//! whoever happened to call `drain`.

use std::time::Instant;

use centraid_api_proto::core_v1 as wire;
use centraid_gateway_client::client::GatewayClient;
use centraid_gateway_client::spool::{Batch, Pending};
use centraid_gateway_client::transport::IrohTransport;
use centraid_vault::Vault;
use centraid_vault::backup::store::BlobStore as _;
use centraid_vault::backup::{self, BackupHome, GenerationManifest, ManifestHead, SegmentRef};

use super::link;
use crate::error::{CoreError, Result};

/// What one pass did.
struct Pass {
    acked_txid: u64,
    acked_at_ms: Option<i64>,
    stopped: wire::DrainStop,
}

/// **Run one drain pass.** See the module header.
///
/// # Errors
/// [`CoreError::Invariant`] for a backup home that will not open or a seal that
/// refuses; [`CoreError::InvalidRequest`] for a stored certificate that will
/// not parse.
pub fn run(
    vault: &Vault,
    vault_file: &std::path::Path,
    keyring: &super::Keyring,
    request: &wire::DrainRequest,
    runtime: &tokio::runtime::Handle,
) -> Result<wire::DrainResponse> {
    let started = Instant::now();
    let home = super::open_home(vault_file)?;
    let spool = home.spool().map_err(|error| CoreError::Invariant {
        context: format!("opening the spool: {error}"),
    })?;

    // 1. SEAL. Everything committed goes into the spool, sealed once; a retry
    //    re-sends the same ciphertext and never reseals it (B9, §4).
    backup::capture(vault, &spool, &keyring.objects).map_err(|error| CoreError::Invariant {
        context: format!("capturing: {error}"),
    })?;
    backup::checkpoint(vault, &spool).map_err(|error| CoreError::Invariant {
        context: format!("checkpointing: {error}"),
    })?;

    // 2. THE LAPTOP. No pairing is not a failed drain: the spool is intact and
    //    the next pass starts where this one did.
    let Some(laptop) = super::Laptop::read(vault_file)? else {
        return answer(&spool, vault_file, None);
    };
    let Some(certificate_hex) = laptop.device_certificate.as_deref() else {
        return Err(CoreError::InvalidRequest {
            detail: "this phone is paired and holds no device certificate; pair again".to_owned(),
        });
    };
    let Some(secret) = keyring.device_secret else {
        return Err(CoreError::Unavailable {
            reason: "this core holds no device secret, so it cannot sign; open it with one"
                .to_owned(),
        });
    };
    let device = link::Device::resume(&secret, certificate_hex)?;

    // W15-2 LANDS THE UPLOAD. Until it does, a paired phone is in exactly the
    // state an unpaired one is: sealed, and nothing sent.
    let _ = (runtime, &device, request.deadline_ms, started, &home);
    answer(&spool, vault_file, None)
}

/// Read the spool back and build the answer. One place, so the numbers a shell
/// draws are always measured after the pass rather than predicted during it.
fn answer(
    spool: &backup::Spool,
    vault_file: &std::path::Path,
    pass: Option<Pass>,
) -> Result<wire::DrainResponse> {
    let pending_bytes = spool.bytes().map_err(|error| CoreError::Invariant {
        context: format!("measuring the spool: {error}"),
    })?;
    let cursor_acked = spool
        .cursor()
        .map_err(|error| CoreError::Invariant {
            context: format!("reading the spool cursor: {error}"),
        })?
        .map_or(0, |cursor| cursor.acked_txid);
    let _ = vault_file;
    let (acked_txid, acked_at_ms, stopped) = match pass {
        // AN UNPAIRED PHONE. Nothing was lost.
        None => (cursor_acked, None, wire::DrainStop::Unreachable),
        Some(pass) => (
            pass.acked_txid.max(cursor_acked),
            pass.acked_at_ms,
            pass.stopped,
        ),
    };
    Ok(wire::DrainResponse {
        acked_txid,
        pending_bytes,
        stopped: stopped as i32,
        acked_at_ms,
    })
}

#[expect(
    clippy::too_many_arguments,
    reason = "one pass needs the vault, its home, its spool, its keys, the laptop, the device, \
              the budget and the moment the budget started; bundling them into a struct would \
              be the same nine values behind a name that explains none of them"
)]
async fn upload(
    vault: &Vault,
    vault_file: &std::path::Path,
    home: &BackupHome,
    spool: &backup::Spool,
    keyring: &super::Keyring,
    laptop: &super::Laptop,
    device: &link::Device,
    deadline_ms: u64,
    started: Instant,
) -> Result<Pass> {
    let blobs = home.objects().map_err(|error| CoreError::Invariant {
        context: format!("opening the object store: {error}"),
    })?;
    let mut client = link::dial(laptop, device, link::vault_id_of(&keyring.vault)).await?;
    let now = link::now_ms;

    // PREFLIGHT AND THE LEASE, IN THAT ORDER. Preflight also corrects this
    // phone's clock off the server's own answer, so a phone that has been off
    // for a month does not spend its first signed request earning a refusal it
    // already had the answer to.
    if let Err(error) = client.preflight(now()).await {
        return unreachable_pass(spool, error);
    }
    // THE EPOCH IS THE CERTIFICATE'S, not a parameter: `claim_lease` signs
    // with this device's certificate and the server reads the epoch off it
    // (`gateway-client`'s `client`). There is exactly one place an epoch is
    // chosen — the pair or the restore that issued the certificate — which is
    // what keeps F3 a property rather than a convention.
    if let Err(error) = client.claim_lease(now()).await {
        return unreachable_pass(spool, error);
    }

    // THE GENERATION THIS PASS CONTINUES, OR A NEW ONE.
    let previous = ManifestHead::read(&home.head_path()).map_err(|error| CoreError::Invariant {
        context: format!("reading the head: {error}"),
    })?;
    let (base, mut carried, mut prev_manifest, base_census) = match previous {
        Some(head) => resume_generation(&keyring.objects, &blobs, &head)?,
        None => found_generation(vault, keyring, home, &blobs, spool)?,
    };

    // THE BASE'S OBJECTS GO FIRST, once, and a re-declare is a no-op.
    let base_objects: Vec<Pending> = base
        .ranges
        .iter()
        .map(|range| Pending {
            name: range.object_name.clone(),
            padded_size: range.object_bytes,
        })
        .collect();

    let mut acked_txid = 0;
    let mut acked_at_ms = None;
    let mut entries = 0_usize;

    // THE SEGMENTS ABOVE THE BASE, in txid order, cut into batches.
    let waiting: Vec<backup::SpoolEntry> = spool
        .entries()
        .map_err(|error| CoreError::Invariant {
            context: format!("listing the spool: {error}"),
        })?
        .into_iter()
        .filter(|entry| entry.last_txid > base.txid)
        .filter(|entry| {
            entry.last_txid > carried.last().map_or(0, |last: &SegmentRef| last.last_txid)
        })
        .collect();

    if waiting.is_empty() {
        return Ok(Pass {
            acked_txid,
            acked_at_ms,
            stopped: wire::DrainStop::Empty,
        });
    }

    let mut remaining: Vec<Pending> = waiting
        .iter()
        .map(|entry| Pending {
            name: entry.object.clone(),
            padded_size: entry.bytes,
        })
        .collect();
    let mut index = 0_usize;

    while index < waiting.len() {
        // RULE 2: the budget is checked BETWEEN entries, and never before the
        // first one. A window too small for a single entry must still make
        // progress.
        if entries > 0 && spent(deadline_ms, started) {
            return Ok(Pass {
                acked_txid,
                acked_at_ms,
                stopped: wire::DrainStop::Deadline,
            });
        }

        let batch = Batch::cut(&remaining);
        let take = batch.objects.len().max(1).min(waiting.len() - index);
        let slice = &waiting[index..index + take];

        let mut fresh = Vec::new();
        for entry in slice {
            let sealed = spool.read(entry).map_err(|error| CoreError::Invariant {
                context: format!("reading a spooled segment: {error}"),
            })?;
            // THE SAME CIPHERTEXT IS RE-SENT, NEVER RESEALED (B9, §4). It is
            // also put into this phone's own object store, because a restore on
            // THIS device reads from there.
            blobs.put(&sealed).map_err(|error| CoreError::Invariant {
                context: format!("keeping a segment: {error}"),
            })?;
            let plain = keyring
                .objects
                .open(centraid_media::object::Kind::Segment, &sealed)
                .map_err(|error| CoreError::Invariant {
                    context: format!("opening a segment this device just sealed: {error}"),
                })?;
            let segment =
                backup::PageSegment::decode(&plain).map_err(|error| CoreError::Invariant {
                    context: format!("decoding a segment this device just sealed: {error}"),
                })?;
            fresh.push((
                SegmentRef {
                    object: entry.object.clone(),
                    first_txid: segment.first_txid,
                    last_txid: segment.last_txid,
                    bytes: sealed.len() as u64,
                    census: segment.census,
                },
                sealed,
            ));
        }

        // THE ENTRY: this batch's segments appended to everything the
        // generation already carries.
        let mut cumulative = carried.clone();
        cumulative.extend(fresh.iter().map(|(reference, _)| reference.clone()));
        cumulative.sort_by_key(|reference| reference.first_txid);
        let manifest = GenerationManifest::of(
            &base,
            vault.clock().now_text(),
            prev_manifest.clone(),
            base_census.clone(),
            cumulative.clone(),
        );
        let (sealed_manifest, manifest_name) =
            manifest
                .seal(&keyring.objects)
                .map_err(|error| CoreError::Invariant {
                    context: format!("sealing a manifest: {error}"),
                })?;
        blobs
            .put(&sealed_manifest)
            .map_err(|error| CoreError::Invariant {
                context: format!("keeping a manifest: {error}"),
            })?;

        let declared: Vec<(String, u64, &'static str)> = base_objects
            .iter()
            .map(|one| (one.name.clone(), one.padded_size, "base"))
            .chain(fresh.iter().map(|(reference, bytes)| {
                (reference.object.clone(), bytes.len() as u64, "segment")
            }))
            .chain(std::iter::once((
                manifest_name.clone(),
                sealed_manifest.len() as u64,
                "manifest",
            )))
            .collect();

        match commit_entry(
            &mut client,
            &blobs,
            &declared,
            &manifest,
            &manifest_name,
            prev_manifest.as_deref(),
            &fresh,
            &sealed_manifest,
        )
        .await
        {
            Err(error) => {
                // NOTHING WAS ACKED, SO NOTHING IS CLAIMED. The spool is
                // untouched and the next pass starts exactly here.
                tracing::debug!(%error, "a drain entry did not commit");
                return Ok(Pass {
                    acked_txid,
                    acked_at_ms,
                    stopped: wire::DrainStop::Unreachable,
                });
            }
            Ok(ack) => {
                // THE ACK IS THE ONLY REMOVER (§2). Everything in this entry is
                // on the laptop, so the spool may let go of it — and only of it.
                let through = manifest.last_txid();
                spool
                    .release_through(through)
                    .map_err(|error| CoreError::Invariant {
                        context: format!("releasing the spool: {error}"),
                    })?;
                if let Some(cursor) = spool.cursor().map_err(|error| CoreError::Invariant {
                    context: format!("reading the spool cursor: {error}"),
                })? {
                    spool
                        .record_cursor(&backup::SpoolCursor {
                            acked_txid: through.max(cursor.acked_txid),
                            ..cursor
                        })
                        .map_err(|error| CoreError::Invariant {
                            context: format!("recording the spool cursor: {error}"),
                        })?;
                }
                ManifestHead {
                    vault_id: keyring.objects.vault_id_hex(),
                    manifest: manifest_name.clone(),
                    generation: base.generation,
                    last_txid: through,
                }
                .write(&home.head_path())
                .map_err(|error| CoreError::Invariant {
                    context: format!("writing the head: {error}"),
                })?;

                acked_txid = through;
                acked_at_ms = Some(ack);
                // THE GATEWAY'S OWN MOMENT, KEPT, so a status read can answer
                // "last backed up" without dialling anything.
                let mut kept = laptop.clone();
                kept.last_acked_at_ms = Some(ack);
                kept.write(vault_file)?;
                prev_manifest = Some(manifest_name);
                carried = cumulative;
                entries += 1;
            }
        }

        index += take;
        remaining.drain(..take.min(remaining.len()));
    }

    Ok(Pass {
        acked_txid,
        acked_at_ms,
        stopped: wire::DrainStop::Empty,
    })
}

/// Declare, PUT, commit. The phone's order, and the only place a
/// `committed_at_ms` a member may be shown comes from.
#[expect(
    clippy::too_many_arguments,
    reason = "a commit needs everything it commits; the alternative is a struct built at the \
              one call site and read at the one use site"
)]
async fn commit_entry(
    client: &mut GatewayClient<IrohTransport>,
    blobs: &backup::FsBlobStore,
    declared: &[(String, u64, &'static str)],
    manifest: &GenerationManifest,
    manifest_name: &str,
    prev_head: Option<&str>,
    fresh: &[(SegmentRef, Vec<u8>)],
    sealed_manifest: &[u8],
) -> std::result::Result<i64, centraid_gateway_client::ClientError> {
    let declarations: Vec<serde_json::Value> = declared
        .iter()
        .map(|(name, size, kind)| {
            serde_json::json!({ "name": name, "kind": kind, "padded_size": size })
        })
        .collect();
    let targets = client
        .declare(
            &serde_json::json!({ "objects": declarations }),
            link::now_ms(),
        )
        .await?;

    // ONLY WHAT THE GATEWAY DOES NOT ALREADY HOLD. Write-once means a
    // re-declared name is an acknowledgement and not an error, which is what
    // makes a pass that was cut off by a deadline cheap to resume.
    for target in &targets {
        if target.already_committed {
            continue;
        }
        let Ok(raw) = hex::decode(&target.name) else {
            continue;
        };
        let Ok(raw): std::result::Result<[u8; 32], _> = raw.try_into() else {
            continue;
        };
        // THE GATEWAY'S OWN NAME TYPE. It is the same 32 bytes as
        // `centraid_media::object::ObjectName` — the BLAKE3 of the ciphertext
        // on both sides of the wire — and `restore_drill` asserts they agree;
        // this is the side that signs, so it is spelled in the rules' own
        // vocabulary.
        let name = centraid_gateway_core::ids::Key32::from_bytes(raw);
        let bytes = if target.name == manifest_name {
            sealed_manifest.to_vec()
        } else if let Some((_, sealed)) = fresh
            .iter()
            .find(|(reference, _)| reference.object == target.name)
        {
            sealed.clone()
        } else {
            // A BASE RANGE, which lives in this phone's own object store.
            match blobs.get(&target.name) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            }
        };
        client.put_object(&name, bytes, link::now_ms()).await?;
    }

    let ack = client
        .commit(
            &serde_json::json!({
                "generation": manifest.generation.hex(),
                "objects": declared.iter().map(|(name, _, _)| name.clone()).collect::<Vec<_>>(),
                "manifest_head": manifest_name,
                "prev_head": prev_head,
                "first_txid": manifest.base_txid + 1,
                "last_txid": manifest.last_txid(),
            }),
            link::now_ms(),
        )
        .await?;
    Ok(ack.committed_at_ms)
}

fn spent(deadline_ms: u64, started: Instant) -> bool {
    // ZERO IS NO DEADLINE — the foreground case, where the member is watching
    // and the pass runs until the spool is empty.
    deadline_ms != 0 && started.elapsed().as_millis() >= u128::from(deadline_ms)
}

fn unreachable_pass(spool: &backup::Spool, error: impl std::fmt::Display) -> Result<Pass> {
    tracing::debug!(%error, "the laptop did not answer this drain");
    let _ = spool;
    Ok(Pass {
        acked_txid: 0,
        acked_at_ms: None,
        stopped: wire::DrainStop::Unreachable,
    })
}

type Resumed = (
    backup::BaseHead,
    Vec<SegmentRef>,
    Option<String>,
    Vec<(String, i64)>,
);

/// The generation the head names, rebuilt from the manifest it points at.
///
/// The same reconstruction `backup::restore::restore_generation` does, and for
/// the same reason: a `BaseHead` is not persisted anywhere, because the
/// manifest already carries every field of it that matters off-device.
fn resume_generation(
    keys: &backup::ObjectKeys,
    blobs: &backup::FsBlobStore,
    head: &ManifestHead,
) -> Result<Resumed> {
    let sealed = blobs
        .get(&head.manifest)
        .map_err(|error| CoreError::Invariant {
            context: format!("reading the head manifest: {error}"),
        })?;
    let manifest =
        GenerationManifest::open(keys, &sealed).map_err(|error| CoreError::Invariant {
            context: format!("opening the head manifest: {error}"),
        })?;
    let base = backup::BaseHead {
        vault_id: manifest.vault_id.clone(),
        file_vault_id: String::new(),
        generation: manifest.generation,
        txid: manifest.base_txid,
        page_size: u32::try_from(centraid_vault::file::PAGE_SIZE).unwrap_or(4096),
        db_size_pages: 0,
        file_bytes: manifest.base_file_bytes,
        plaintext_hash: manifest.base_plaintext_hash.clone(),
        ranges: manifest.base.clone(),
    };
    Ok((
        base,
        manifest.segments.clone(),
        Some(head.manifest.clone()),
        manifest.base_census.clone(),
    ))
}

/// A vault with no head yet: take the base this generation is about.
fn found_generation(
    vault: &Vault,
    keyring: &super::Keyring,
    home: &BackupHome,
    blobs: &backup::FsBlobStore,
    spool: &backup::Spool,
) -> Result<Resumed> {
    let cursor = spool
        .cursor()
        .map_err(|error| CoreError::Invariant {
            context: format!("reading the spool cursor: {error}"),
        })?
        .ok_or_else(|| CoreError::Invariant {
            context: "capture left no cursor, which cannot happen".to_owned(),
        })?;
    let base_census = vault.census().map_err(|error| CoreError::Invariant {
        context: format!("taking a census: {error}"),
    })?;
    link::ensure_dir(&home.scratch())?;
    let base = backup::build_base(
        vault,
        &keyring.objects,
        blobs,
        cursor.generation,
        cursor.last_txid,
        &home.scratch(),
    )
    .map_err(|error| CoreError::Invariant {
        context: format!("taking a base: {error}"),
    })?;
    // WRITING THE RANGE INDEX WAS A COMMIT (B5), so there is a tail and it
    // belongs to this generation. Capture it before any batch is cut.
    backup::capture(vault, spool, &keyring.objects).map_err(|error| CoreError::Invariant {
        context: format!("capturing the tail after the base: {error}"),
    })?;
    Ok((base, Vec::new(), None, base_census))
}
