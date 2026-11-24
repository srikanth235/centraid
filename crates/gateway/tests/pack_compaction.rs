//! SPARSE PACKFILE COMPACTION AND SMALL-PACK COALESCING (`CGW4`, #1212, spec §4).
//!
//! When ≥ 50% of a packfile's bytes belong to purged objects (`live_bytes * 2 <= file_len`),
//! or when ≥ 2 small packfiles (`< 16 MiB`) exist for an unfrozen vault,
//! `compact_packs_once` copies remaining object slices sequentially into a new
//! dense packfile under `staging/`, `fsync`s it, renames it into `packs/<vault>/`,
//! remaps `(pack_id, pack_offset)` in one `BEGIN IMMEDIATE … COMMIT` transaction,
//! and unlinks the old `.pack` files — preserving every byte and digest on
//! `GET`, ranged `GET`, `POST /fetch`, and `scrub`.

use centraid_gateway::client::Client;
use centraid_gateway::rules::bundle::Frame;
use centraid_gateway::rules::ids::{Digest, Name, VaultId};
use centraid_gateway::rules::limits::GRACE_MS;
use centraid_gateway::rules::range::ByteRange;
use centraid_gateway::rules::signing::sign_delete;
use centraid_gateway::rules::wire::DeleteRequest;
use centraid_gateway::server::harness::{Spawned, pair_secret, spawn};
use centraid_gateway::server::sweeps::compact_packs_once;

struct Paired {
    key: ed25519_dalek::SigningKey,
    vault: VaultId,
    phone: Client,
    generation: u64,
}

async fn setup_paired(gateway: &Spawned, seed: u8) -> Paired {
    let key = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    let vault = VaultId::from_bytes(key.verifying_key().to_bytes());
    let paired = pair_secret(
        &gateway.first_contact(),
        &key,
        "compaction-phone",
        gateway.mint_pairing_secret(),
    )
    .await
    .expect("pairs");
    Paired {
        key,
        vault,
        phone: gateway.client(paired.token),
        generation: 0,
    }
}

fn make_frame(label: &str, len: usize) -> Frame {
    let name = Name::from_bytes(blake3::derive_key("pack compaction name", label.as_bytes()));
    let mut bytes = vec![0_u8; len];
    blake3::Hasher::new_derive_key("pack compaction bytes")
        .update(label.as_bytes())
        .finalize_xof()
        .fill(&mut bytes);
    Frame::of(name, bytes)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sparse_pack_compaction_after_purge_rewrites_live_slices_and_unlinks_old_pack() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let mut member = setup_paired(&gateway, 51).await;

    // Upload 4 objects (128 KiB each = 512 KiB) in one bundle -> 1 packfile.
    let frames: Vec<Frame> = (0..4)
        .map(|i| make_frame(&format!("sparse-{i}"), 128 * 1024))
        .collect();
    let answer = member
        .phone
        .bundle(&member.vault, &frames)
        .await
        .expect("stores");
    assert_eq!(answer.stored(), 4);

    let initial_packs = gateway.shared().store().pack_files().expect("lists");
    assert_eq!(initial_packs.len(), 1);
    let initial_pack_id = initial_packs[0].pack_id;
    assert_eq!(initial_packs[0].len, 4 * 128 * 1024);

    // Soft-delete frames[0] and frames[2] (256 KiB = 50% of 512 KiB).
    member.generation += 1;
    let deleted_names = vec![frames[0].name, frames[2].name];
    let sig = sign_delete(
        &member.key,
        &gateway.gateway_id,
        1,
        member.generation,
        None,
        &deleted_names,
    );
    member
        .phone
        .delete(
            &member.vault,
            &DeleteRequest {
                names: deleted_names.clone(),
                generation: member.generation,
                head_root: None,
                signature: sig,
            },
        )
        .await
        .expect("holds two objects");

    // Step through the 7-day grace in 1-hour increments so watched time expires,
    // then run `purge_now` (which runs purge + `compact_packs_once`).
    const HOUR_MS: i64 = 3_600_000;
    let mut elapsed = 0_i64;
    while elapsed <= GRACE_MS {
        gateway.advance_clock(HOUR_MS);
        elapsed += HOUR_MS;
        let purged = gateway.purge_now().await.expect("sweeps");
        if purged > 0 {
            assert_eq!(purged, 2, "both held objects purged together");
            break;
        }
    }

    let after_packs = gateway.shared().store().pack_files().expect("lists");
    assert_eq!(
        after_packs.len(),
        1,
        "compacted into one new dense packfile"
    );
    assert_ne!(
        after_packs[0].pack_id, initial_pack_id,
        "the sparse packfile was replaced and unlinked"
    );
    assert!(
        !gateway
            .shared()
            .store()
            .pack_path(&member.vault, &initial_pack_id)
            .exists(),
        "old sparse packfile unlinked from disk"
    );
    assert_eq!(
        after_packs[0].len,
        2 * 128 * 1024,
        "new packfile holds only the 256 KiB of live objects"
    );

    // Every surviving object's bytes, subranges, and digests remain exact.
    for kept in [&frames[1], &frames[3]] {
        let full = member
            .phone
            .get(&member.vault, &kept.name, None)
            .await
            .expect("GET full");
        assert_eq!(full, kept.bytes);

        let sub = member
            .phone
            .get(
                &member.vault,
                &kept.name,
                Some(ByteRange {
                    first: 1000,
                    last: Some(5095),
                }),
            )
            .await
            .expect("GET ranged");
        assert_eq!(sub, kept.bytes[1000..=5095]);
    }

    let fetched = member
        .phone
        .fetch(
            &member.vault,
            &[frames[3].name, frames[0].name, frames[1].name],
        )
        .await
        .expect("POST /fetch");
    assert_eq!(fetched.len(), 2);
    assert_eq!(fetched[0].name, frames[3].name);
    assert_eq!(fetched[0].bytes, frames[3].bytes);
    assert_eq!(fetched[0].digest, Digest::of(&frames[3].bytes));
    assert_eq!(fetched[1].name, frames[1].name);
    assert_eq!(fetched[1].bytes, frames[1].bytes);

    let scrub = gateway.scrub_now().await.expect("scrubs compacted pack");
    assert_eq!((scrub.read, scrub.corrupt, scrub.missing), (2, 0, 0));

    gateway.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn small_pack_coalescing_merges_multiple_small_packs_and_preserves_bytes() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let member = setup_paired(&gateway, 52).await;

    // Upload 4 separate small bundles -> 4 distinct `.pack` files (< 16 MiB each).
    let bundles: Vec<Vec<Frame>> = vec![
        vec![make_frame("b0-a", 17_000), make_frame("b0-b", 31_500)],
        vec![make_frame("b1-a", 65_536)],
        vec![make_frame("b2-a", 0), make_frame("b2-b", 42_123)],
        vec![make_frame("b3-a", 99_999)],
    ];
    let mut all_frames = Vec::new();
    for batch in &bundles {
        let answer = member
            .phone
            .bundle(&member.vault, batch)
            .await
            .expect("stores");
        assert_eq!(answer.stored(), batch.len());
        all_frames.extend_from_slice(batch);
    }

    let before_packs = gateway.shared().store().pack_files().expect("lists");
    assert_eq!(
        before_packs.len(),
        4,
        "four small packfiles before coalescing"
    );
    let expected_total_bytes: u64 = all_frames.iter().map(|f| f.bytes.len() as u64).sum();

    let coalesced = compact_packs_once(gateway.shared()).expect("coalesces small packs");
    assert_eq!(
        coalesced, 4,
        "all four old small packfiles coalesced and unlinked"
    );

    let after_packs = gateway.shared().store().pack_files().expect("lists");
    assert_eq!(after_packs.len(), 1, "one dense packfile remains");
    assert_eq!(after_packs[0].len, expected_total_bytes);

    for old in &before_packs {
        assert!(
            !gateway
                .shared()
                .store()
                .pack_path(&member.vault, &old.pack_id)
                .exists(),
            "old small packfile {} was unlinked",
            old.pack_id
        );
    }

    // Running compaction again on a single dense small pack is a no-op.
    assert_eq!(compact_packs_once(gateway.shared()).expect("idempotent"), 0);

    let names: Vec<Name> = all_frames.iter().map(|f| f.name).collect();
    let fetched = member
        .phone
        .fetch(&member.vault, &names)
        .await
        .expect("fetch");
    assert_eq!(fetched.len(), all_frames.len());
    for (got, want) in fetched.iter().zip(&all_frames) {
        assert_eq!(got.name, want.name);
        assert_eq!(got.digest, want.digest);
        assert_eq!(got.bytes, want.bytes);
        assert_eq!(
            member
                .phone
                .get(&member.vault, &want.name, None)
                .await
                .expect("GET"),
            want.bytes
        );
    }

    let scrub = gateway.scrub_now().await.expect("scrubs coalesced pack");
    assert_eq!(
        (scrub.read, scrub.corrupt, scrub.missing),
        (all_frames.len() as u64, 0, 0)
    );

    gateway.shutdown().await;
}
