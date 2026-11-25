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
use centraid_gateway::rules::bundle::{Frame, HEADER_LEN};
use centraid_gateway::rules::engine::Finding;
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

/// Important #2: `GET` and `POST /fetch` open packfile handles inside the
/// blocking read-planning lock, so deleting/compacting the old packfile once
/// the response stream has started never causes a mid-body error or false
/// `NOT_FOUND`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_and_fetch_complete_cleanly_when_compaction_unlinks_old_packfile_mid_stream() {
    use http_body_util::BodyExt as _;
    use hyper_util::rt::TokioIo;
    use tokio_rustls::TlsConnector;
    use tokio_rustls::rustls::pki_types::ServerName;

    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");

    // Upload two separate small bundles so `compact_packs_once` will coalesce
    // them into a new packfile and unlink the originals. Use > 256 KiB per
    // object so streaming takes multiple chunks after the response headers.
    let f0 = make_frame("stream-0", 512 * 1024);
    let f1 = make_frame("stream-1", 512 * 1024);

    let raw_key = ed25519_dalek::SigningKey::from_bytes(&[55; 32]);
    let raw_vault = VaultId::from_bytes(raw_key.verifying_key().to_bytes());
    let raw_paired = pair_secret(
        &gateway.first_contact(),
        &raw_key,
        "raw-phone",
        gateway.mint_pairing_secret(),
    )
    .await
    .expect("pairs raw vault");
    let raw_client = gateway.client(raw_paired.token);
    assert_eq!(
        raw_client
            .bundle(&raw_vault, std::slice::from_ref(&f0))
            .await
            .expect("stores f0")
            .stored(),
        1
    );
    assert_eq!(
        raw_client
            .bundle(&raw_vault, std::slice::from_ref(&f1))
            .await
            .expect("stores f1")
            .stored(),
        1
    );
    let raw_old_packs = gateway
        .shared()
        .store()
        .vault_pack_files(&raw_vault)
        .expect("lists raw vault packs");
    assert_eq!(raw_old_packs.len(), 2);

    let tls_config = centraid_gateway::client::tls::client_config(
        centraid_gateway::client::tls::Trust::Certificate(gateway.cert_der.clone()),
    );

    // 1. Start GET /o/<f0.name>, read headers (200 OK), then run compaction so
    //    both old packfiles are unlinked while GET body is still unread.
    let get_socket = tokio::net::TcpStream::connect(gateway.addr)
        .await
        .expect("connects");
    let get_tls = TlsConnector::from(tls_config.clone())
        .connect(ServerName::try_from("localhost").expect("name"), get_socket)
        .await
        .expect("handshakes");
    let (mut get_sender, get_conn) = hyper::client::conn::http1::handshake(TokioIo::new(get_tls))
        .await
        .expect("http1");
    tokio::spawn(get_conn);
    let get_req = hyper::Request::builder()
        .method("GET")
        .uri(format!("/v1/v/{raw_vault}/o/{}", f0.name))
        .header("host", gateway.addr.to_string())
        .header("authorization", format!("Bearer {}", raw_paired.token))
        .body(http_body_util::Empty::<bytes::Bytes>::new())
        .expect("request");
    let get_resp = get_sender.send_request(get_req).await.expect("GET headers");
    assert_eq!(get_resp.status(), 200);

    // 2. Also start POST /fetch for both f0 and f1, receive headers (200 OK)
    //    before reading the body.
    let fetch_socket = tokio::net::TcpStream::connect(gateway.addr)
        .await
        .expect("connects");
    let fetch_tls = TlsConnector::from(tls_config)
        .connect(
            ServerName::try_from("localhost").expect("name"),
            fetch_socket,
        )
        .await
        .expect("handshakes");
    let (mut fetch_sender, fetch_conn) =
        hyper::client::conn::http1::handshake(TokioIo::new(fetch_tls))
            .await
            .expect("http1");
    tokio::spawn(fetch_conn);
    let fetch_body = serde_json::to_vec(&serde_json::json!({
        "names": [f0.name.to_string(), f1.name.to_string()],
    }))
    .expect("json");
    let fetch_req = hyper::Request::builder()
        .method("POST")
        .uri(format!("/v1/v/{raw_vault}/fetch"))
        .header("host", gateway.addr.to_string())
        .header("authorization", format!("Bearer {}", raw_paired.token))
        .header("content-type", "application/json")
        .header("content-length", fetch_body.len())
        .body(http_body_util::Full::new(bytes::Bytes::from(fetch_body)))
        .expect("request");
    let fetch_resp = fetch_sender
        .send_request(fetch_req)
        .await
        .expect("POST fetch headers");
    assert_eq!(fetch_resp.status(), 200);

    // Compact while both response streams are open; old packfiles are unlinked.
    let shared_for_compact = gateway.shared().clone();
    let compacted = tokio::task::spawn_blocking(move || compact_packs_once(&shared_for_compact))
        .await
        .expect("joins")
        .expect("compacts");
    assert!(compacted >= 2, "coalesced at least the 2 old packfiles");
    for old in &raw_old_packs {
        assert!(
            !gateway
                .shared()
                .store()
                .pack_path(&raw_vault, &old.pack_id)
                .exists(),
            "old packfile {} unlinked while GET and fetch streams are in flight",
            old.pack_id
        );
    }

    // Both GET and POST /fetch finish streaming every byte intact.
    let get_bytes = get_resp
        .into_body()
        .collect()
        .await
        .expect("GET body")
        .to_bytes();
    assert_eq!(get_bytes.as_ref(), f0.bytes.as_slice());

    let fetch_bytes = fetch_resp
        .into_body()
        .collect()
        .await
        .expect("fetch body")
        .to_bytes();
    let expected_fetch_len = (HEADER_LEN + f0.bytes.len()) + (HEADER_LEN + f1.bytes.len());
    assert_eq!(fetch_bytes.len(), expected_fetch_len);
    assert_eq!(
        &fetch_bytes[HEADER_LEN..HEADER_LEN + f0.bytes.len()],
        f0.bytes.as_slice()
    );
    assert_eq!(
        &fetch_bytes[HEADER_LEN + f0.bytes.len() + HEADER_LEN..],
        f1.bytes.as_slice()
    );

    gateway.shutdown().await;
}

/// Important #3: recording a `Finding::Missing` against a stale pre-compaction
/// `PackLocation` after `compact_packs_once` leaves `damaged_at_ms == None`
/// and the object still serves cleanly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stale_pre_compaction_scrub_finding_does_not_mark_relocated_object_damaged() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let member = setup_paired(&gateway, 56).await;

    let f0 = make_frame("stale-0", 16 * 1024);
    let f1 = make_frame("stale-1", 16 * 1024);
    assert_eq!(
        member
            .phone
            .bundle(&member.vault, std::slice::from_ref(&f0))
            .await
            .expect("stores f0")
            .stored(),
        1
    );
    assert_eq!(
        member
            .phone
            .bundle(&member.vault, std::slice::from_ref(&f1))
            .await
            .expect("stores f1")
            .stored(),
        1
    );

    let (record_before, stale_loc) = gateway
        .shared()
        .rules(|gw| Ok(gw.state.object_with_location(&member.vault, &f1.name)?))
        .expect("reads")
        .expect("present");

    // Compaction relocates `f1` into a new coalesced packfile and unlinks the old one.
    let compacted = compact_packs_once(gateway.shared()).expect("compacts");
    assert_eq!(compacted, 2);

    let (record_after, new_loc) = gateway
        .shared()
        .rules(|gw| Ok(gw.state.object_with_location(&member.vault, &f1.name)?))
        .expect("reads")
        .expect("still present");
    assert_ne!(new_loc.pack_id, stale_loc.pack_id);
    assert_eq!(record_after.damaged_at_ms, None);

    // Simulating `scrub_once` racing with compaction: recording `Finding::Missing`
    // at `stale_loc` must return `false` and leave `damaged_at_ms == None`.
    let recorded = gateway
        .shared()
        .rules(|gw| {
            gw.state.record_scrub_at_location(
                &member.vault,
                &record_before,
                stale_loc,
                Finding::Missing,
                123_456,
            )
        })
        .expect("location-checked scrub");
    assert!(!recorded, "stale pre-compaction location must be ignored");

    let (record_checked, _) = gateway
        .shared()
        .rules(|gw| Ok(gw.state.object_with_location(&member.vault, &f1.name)?))
        .expect("reads")
        .expect("still present");
    assert_eq!(record_checked.damaged_at_ms, None);

    // Object still serves cleanly over GET.
    let got = member
        .phone
        .get(&member.vault, &f1.name, None)
        .await
        .expect("serves cleanly");
    assert_eq!(got, f1.bytes);

    gateway.shutdown().await;
}
