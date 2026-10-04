//! The client a phone's store is built on, against the real gateway (#1080).
//!
//! Two of the root's rulings are the subject. **A15**: a `PUT` is answered
//! `Stored`, `AlreadyStored` or `NameTaken`, and all three are
//! acknowledgements — a name is a function of the plaintext and sealing is
//! salted, so the same bytes sealed again arrive under another digest; a
//! bundle answers each frame as its own `PUT` would. **A14**: a snapshot of a
//! large vault is thousands of 64 KiB ranges sent through `bundle` and
//! restored through `fetch`, in bodies of up to 256 MiB, and neither end may
//! hold such a body whole. That is proved twice: the gateway admits a frame
//! while the rest of its body is still unsent, and a bundle of nearly 256 MiB
//! goes up from files and comes back frame by frame while the process's
//! resident memory grows by a fraction of it.

// THE MEMORY PROOF READS `/proc`, so it and every piece only it uses are
// Linux's; on a Mac they would be dead code under `-D warnings`.
#[cfg(target_os = "linux")]
use std::io::Write as _;
#[cfg(target_os = "linux")]
use std::path::Path;
#[cfg(target_os = "linux")]
use std::sync::Arc;
#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use bytes::Bytes;
use centraid_gateway::client::tls::{Trust, client_config};
use centraid_gateway::client::{Client, Put};
#[cfg(target_os = "linux")]
use centraid_gateway::client::{Part, Source};
use centraid_gateway::rules::bundle::{Frame, HEADER_LEN, header as frame_header};
use centraid_gateway::rules::code::Code;
use centraid_gateway::rules::ids::{Digest, Name, Token, VaultId};
#[cfg(target_os = "linux")]
use centraid_gateway::rules::limits::MAX_BUNDLE_BYTES;
use centraid_gateway::rules::wire::{BundleAnswer, PairKind, PairRequest};
use centraid_gateway::server::harness::{Spawned, spawn};
use futures::StreamExt as _;
use http_body_util::{BodyExt as _, StreamBody};
use hyper_util::rt::TokioIo;
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls::pki_types::ServerName;

/// A vault paired with `gateway`, and the client holding its token.
async fn paired(gateway: &Spawned, seed: u8) -> (VaultId, Client, Token) {
    let identity = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    let vault = VaultId::from_bytes(identity.verifying_key().to_bytes());
    let phone = gateway.first_contact();
    let paired = phone
        .pair(&PairRequest {
            vault_id: vault,
            label: "a phone".to_owned(),
            kind: PairKind::Secret,
            secret: Some(gateway.mint_pairing_secret()),
            claim: None,
            read: None,
        })
        .await
        .expect("pairs");
    (vault, gateway.client(paired.token), paired.token)
}

/// Bytes nobody can open under a name nobody can compute, from a seed.
fn part(seed: &str, len: usize) -> (Name, Vec<u8>) {
    let name = Name::from_bytes(blake3::derive_key(
        "centraid gateway store client name",
        seed.as_bytes(),
    ));
    let mut bytes = vec![0_u8; len];
    let mut hasher = blake3::Hasher::new_derive_key("centraid gateway store client bytes");
    hasher.update(seed.as_bytes());
    hasher.finalize_xof().fill(&mut bytes);
    (name, bytes)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_put_answer_the_client_returns_is_an_acknowledgement() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, phone, _) = paired(&gateway, 1).await;
    let (name, sealed) = part("sealed once", 4096);
    let digest = Digest::of(&sealed);

    let first = phone
        .put(&vault, &name, &digest, sealed.clone())
        .await
        .expect("stores");
    assert!(
        matches!(first, Put::Stored(entry) if entry.name == name && entry.digest == digest),
        "{first:?}"
    );
    let again = phone
        .put(&vault, &name, &digest, sealed.clone())
        .await
        .expect("acknowledges");
    assert!(matches!(again, Put::AlreadyStored(_)), "{again:?}");
    let resealed = part("the same plaintext, sealed again", 4096).1;
    let taken = phone
        .put(&vault, &name, &Digest::of(&resealed), resealed.clone())
        .await
        .expect("NAME_TAKEN is an acknowledgement, not an error");
    assert_eq!(taken, Put::NameTaken { held: digest });
    assert_eq!(
        phone.get(&vault, &name, None).await.expect("reads"),
        sealed,
        "the held bytes are untouched"
    );

    // A bundle answers each frame as its own PUT would, and what a phone may
    // record is every frame the gateway now holds a sealing of.
    let (fresh, fresh_bytes) = part("fresh", 512);
    let answer = phone
        .bundle(
            &vault,
            &[
                Frame::of(fresh, fresh_bytes),
                Frame::of(name, sealed.clone()),
                Frame::of(name, resealed),
            ],
        )
        .await
        .expect("answers");
    assert_eq!(answer.stored, vec![fresh]);
    assert_eq!(answer.already, vec![name]);
    assert_eq!(
        answer
            .refused
            .iter()
            .map(|refusal| (refusal.name, refusal.code))
            .collect::<Vec<_>>(),
        vec![(name, Code::NameTaken)]
    );
    assert_eq!(answer.acknowledged(), vec![fresh, name, name]);
    gateway.shutdown().await;
}

/// THE GATEWAY ADMITS A BUNDLE FRAME AS IT ARRIVES. The body is fed by hand:
/// the first frame whole and the second frame's header, then nothing until
/// another connection sees the first frame held. A gateway that read the
/// body whole before admitting anything would hold nothing yet, and this
/// would time out.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bundle_frame_is_held_before_the_rest_of_its_body_is_sent() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, phone, token) = paired(&gateway, 2).await;
    let (first, first_bytes) = part("first frame", 64 * 1024);
    let (second, second_bytes) = part("second frame", 64 * 1024);
    let length = 2 * (HEADER_LEN + 64 * 1024);

    let socket = tokio::net::TcpStream::connect(gateway.addr)
        .await
        .expect("connects");
    let tls = TlsConnector::from(client_config(Trust::Certificate(gateway.cert_der.clone())))
        .connect(ServerName::try_from("localhost").expect("a name"), socket)
        .await
        .expect("handshakes");
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(tls))
        .await
        .expect("speaks HTTP/1.1");
    tokio::spawn(connection);
    let (feed, fed) = futures::channel::mpsc::unbounded::<Bytes>();
    let body =
        StreamBody::new(fed.map(|bytes| Ok::<_, std::io::Error>(hyper::body::Frame::data(bytes))));
    let request = hyper::Request::builder()
        .method("POST")
        .uri(format!("/v2/v/{vault}/bundle"))
        .header("host", gateway.addr.to_string())
        .header("authorization", format!("Bearer {token}"))
        .header("content-length", length)
        .header("content-type", "application/octet-stream")
        .body(body)
        .expect("a request");
    let answered = tokio::spawn(async move {
        let response = sender.send_request(request).await.expect("answered");
        assert_eq!(response.status(), 200);
        let bytes = response.into_body().collect().await.expect("a body");
        serde_json::from_slice::<BundleAnswer>(&bytes.to_bytes()).expect("a bundle answer")
    });

    let send = |bytes: &[u8]| {
        feed.unbounded_send(Bytes::copy_from_slice(bytes))
            .expect("the body is still open");
    };
    send(&frame_header(
        &first,
        &Digest::of(&first_bytes),
        first_bytes.len() as u64,
    ));
    send(&first_bytes);
    send(&frame_header(
        &second,
        &Digest::of(&second_bytes),
        second_bytes.len() as u64,
    ));

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let missing = phone
            .exists(&vault, &[first, second])
            .await
            .expect("exists");
        if missing == vec![second] {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the first frame was not held while the body was still open: missing {missing:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    send(&second_bytes);
    feed.close_channel();
    let answer = answered.await.expect("the request task");
    assert_eq!(answer.stored, vec![first, second]);
    gateway.shutdown().await;
}

#[cfg(target_os = "linux")]
/// This process's resident memory, in bytes.
fn resident() -> u64 {
    let status = std::fs::read_to_string("/proc/self/status").expect("Linux exposes it");
    status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))
        .and_then(|rest| rest.trim().strip_suffix("kB"))
        .and_then(|kib| kib.trim().parse::<u64>().ok())
        .map(|kib| kib * 1024)
        .expect("a VmRSS line")
}

#[cfg(target_os = "linux")]
/// The highest resident size seen while `run` runs, sampled every
/// millisecond on a thread of its own.
async fn peak_resident<T>(run: impl Future<Output = T>) -> (T, u64) {
    let peak = Arc::new(AtomicU64::new(resident()));
    let done = Arc::new(AtomicBool::new(false));
    let sampler = {
        let (peak, done) = (Arc::clone(&peak), Arc::clone(&done));
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                peak.fetch_max(resident(), Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    };
    let out = run.await;
    done.store(true, Ordering::SeqCst);
    sampler.join().expect("the sampler");
    peak.fetch_max(resident(), Ordering::SeqCst);
    (out, peak.load(Ordering::SeqCst))
}

#[cfg(target_os = "linux")]
/// Write `count` parts of `len` bytes into `dir`, one at a time.
fn spool(dir: &Path, count: usize, len: usize) -> Vec<(Name, Digest, std::path::PathBuf)> {
    (0..count)
        .map(|index| {
            let (name, bytes) = part(&format!("range {index}"), len);
            let path = dir.join(name.to_string());
            std::fs::File::create(&path)
                .and_then(|mut file| file.write_all(&bytes))
                .expect("spools a part");
            (name, Digest::of(&bytes), path)
        })
        .collect()
}

/// A BUNDLE OF NEARLY 256 MiB NEVER SITS IN MEMORY. Sixty-three 4 MiB parts
/// go up from spool files through `bundle_parts` and come back through
/// `fetch_each`; the gateway and the phone share this process, so its
/// resident size bounds both ends at once. Holding the body whole anywhere —
/// encoding it, reading it before staging, collecting the fetch answer —
/// would add the whole quarter-gibibyte.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_quarter_gibibyte_bundle_streams_up_and_back() {
    const PART: usize = 4 * 1024 * 1024;
    const COUNT: usize = 63;
    const BOUND: u64 = 64 * 1024 * 1024;
    let total = (COUNT * (HEADER_LEN + PART)) as u64;
    assert!(
        total <= MAX_BUNDLE_BYTES && total + (HEADER_LEN + PART) as u64 > MAX_BUNDLE_BYTES,
        "the bundle is as large as the cap allows"
    );

    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(&dir.path().join("gateway")).await.expect("spawned");
    let (vault, phone, _) = paired(&gateway, 3).await;
    let spooled = dir.path().join("spool");
    std::fs::create_dir_all(&spooled).expect("a spool");
    let parts = spool(&spooled, COUNT, PART);
    let names: Vec<Name> = parts.iter().map(|(name, _, _)| *name).collect();

    // Warm the connection and the runtime, so the baseline is a steady one.
    let (warm, warm_bytes) = part("warm-up", PART);
    phone
        .bundle(&vault, &[Frame::of(warm, warm_bytes)])
        .await
        .expect("a warm-up bundle");
    phone.fetch(&vault, &[warm]).await.expect("a warm-up fetch");
    let baseline = resident();

    let (answer, up_peak) = peak_resident(
        phone.bundle_parts(
            &vault,
            parts
                .iter()
                .map(|(name, digest, path)| Part {
                    name: *name,
                    digest: *digest,
                    source: Source::File(path.clone()),
                })
                .collect(),
        ),
    )
    .await;
    let answer = answer.expect("the bundle is answered");
    assert_eq!(answer.stored, names, "every part is stored");
    assert!(answer.refused.is_empty(), "{:?}", answer.refused);

    let mut back = Vec::new();
    let (fetched, down_peak) = peak_resident(phone.fetch_each(&vault, &names, |frame| {
        back.push((frame.name, frame.bytes.len()));
        Ok(())
    }))
    .await;
    assert_eq!(fetched.expect("the fetch is answered"), COUNT);
    assert_eq!(
        back,
        names.iter().map(|name| (*name, PART)).collect::<Vec<_>>(),
        "every part comes back whole, in order"
    );

    let (up, down) = (
        up_peak.saturating_sub(baseline),
        down_peak.saturating_sub(baseline),
    );
    println!(
        "{} MiB up and back: resident grew {} MiB up, {} MiB down",
        total >> 20,
        up >> 20,
        down >> 20
    );
    assert!(
        up < BOUND && down < BOUND,
        "a {} MiB bundle grew the process by {} MiB up and {} MiB down; \
         a body is being held whole",
        total >> 20,
        up >> 20,
        down >> 20
    );
    gateway.shutdown().await;
}
