//! The client a phone's store is built on, against the real gateway (#1080).
//!
//! **Decision 30**: a frame is answered `stored`, `there`, `held` or `taken`,
//! and only the first three are acknowledgements — a name is a function of
//! the plaintext, and a `taken` under another digest is a name the phone must
//! not count as stored. **Spec §4**: a frame is committed on its own as its
//! last byte arrives, so a body cut inside frame k leaves frames before k
//! committed and k absent. **A14**: a snapshot of a large vault is thousands
//! of ranges sent through `bundle` and restored through `fetch`, in bodies of
//! up to 256 MiB, and neither end may hold such a body whole. That is proved
//! twice: the gateway commits a frame while the rest of its body is still
//! unsent, and a bundle of nearly 256 MiB goes up from files and comes back
//! frame by frame while the process's resident memory grows by a fraction of
//! it.

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
#[cfg(target_os = "linux")]
use std::time::Duration;

use bytes::Bytes;
use centraid_gateway::client::Client;
use centraid_gateway::client::tls::{Trust, client_config};
#[cfg(target_os = "linux")]
use centraid_gateway::client::{Part, Source};
use centraid_gateway::rules::bundle::{Frame, HEADER_LEN, header as frame_header};
use centraid_gateway::rules::ids::{Digest, Name, Token, VaultId};
#[cfg(target_os = "linux")]
use centraid_gateway::rules::limits::MAX_BUNDLE_BYTES;
use centraid_gateway::rules::wire::{BundleAnswer, FrameResult, NameState};
use centraid_gateway::server::harness::pair_secret;
use centraid_gateway::server::harness::{Spawned, put, spawn};
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
    let paired = pair_secret(
        &phone,
        &identity,
        "a phone".to_owned(),
        gateway.mint_pairing_secret(),
    )
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
async fn a_frame_answer_is_an_acknowledgement_only_for_the_phones_own_bytes() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, phone, _) = paired(&gateway, 1).await;
    let (name, sealed) = part("sealed once", 4096);
    let digest = Digest::of(&sealed);

    let first = put(&phone, &vault, &name, &digest, sealed.clone())
        .await
        .expect("stores");
    assert_eq!(first, FrameResult::Stored { name }, "{first:?}");
    let again = put(&phone, &vault, &name, &digest, sealed.clone())
        .await
        .expect("acknowledges");
    assert_eq!(again, FrameResult::There { name });
    let resealed = part("the same plaintext, sealed again", 4096).1;
    let taken = put(
        &phone,
        &vault,
        &name,
        &Digest::of(&resealed),
        resealed.clone(),
    )
    .await
    .expect("a taken name is an answer, not an error");
    assert_eq!(
        taken,
        FrameResult::Taken {
            name,
            digest,
            state: NameState::Live,
        }
    );
    assert_eq!(
        phone.get(&vault, &name, None).await.expect("reads"),
        sealed,
        "the held bytes are untouched"
    );

    // A bundle answers one result per frame, in order, and what a phone may
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
    assert_eq!(
        answer.results,
        vec![
            FrameResult::Stored { name: fresh },
            FrameResult::There { name },
            FrameResult::Taken {
                name,
                digest,
                state: NameState::Live
            },
        ]
    );
    assert_eq!(answer.acknowledged(), vec![fresh, name]);
    assert_eq!(
        answer.taken(),
        vec![(name, digest, NameState::Live)],
        "the taken frame is typed, with the digest the gateway holds"
    );
    gateway.shutdown().await;
}

/// A raw HTTP/1.1 bundle upload whose body the test feeds by hand, so it can
/// stop after any byte: the answer, when there is one, comes back through
/// `answered`.
struct Upload {
    feed: futures::channel::mpsc::UnboundedSender<Bytes>,
    answered: tokio::task::JoinHandle<Option<BundleAnswer>>,
}

impl Upload {
    async fn open(gateway: &Spawned, vault: &VaultId, token: &Token, length: usize) -> Self {
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
        let body = StreamBody::new(
            fed.map(|bytes| Ok::<_, std::io::Error>(hyper::body::Frame::data(bytes))),
        );
        let request = hyper::Request::builder()
            .method("POST")
            .uri(format!("/v1/v/{vault}/bundle"))
            .header("host", gateway.addr.to_string())
            .header("authorization", format!("Bearer {token}"))
            .header("content-length", length)
            .header("content-type", "application/octet-stream")
            .body(body)
            .expect("a request");
        let answered = tokio::spawn(async move {
            let response = sender.send_request(request).await.ok()?;
            let bytes = response.into_body().collect().await.ok()?;
            serde_json::from_slice::<BundleAnswer>(&bytes.to_bytes()).ok()
        });
        Self { feed, answered }
    }

    fn send(&self, bytes: &[u8]) {
        self.feed
            .unbounded_send(Bytes::copy_from_slice(bytes))
            .expect("the body is still open");
    }
}

/// Wait until `count` frames are staged on disk, by event, not by clock.
fn staged_events(gateway: &Spawned) -> std::sync::mpsc::Receiver<u64> {
    let (tx, rx) = std::sync::mpsc::channel::<u64>();
    gateway
        .shared()
        .store()
        .knobs()
        .on_staged(Some(std::sync::Arc::new(move |size| {
            let _ = tx.send(size);
        })));
    rx
}

/// Wait until `count` frames are committed in `state.db`, by event, not by clock.
fn committed_events(gateway: &Spawned) -> std::sync::mpsc::Receiver<usize> {
    let (tx, rx) = std::sync::mpsc::channel::<usize>();
    gateway
        .shared()
        .store()
        .knobs()
        .on_committed(Some(std::sync::Arc::new(move |nth| {
            let _ = tx.send(nth);
        })));
    rx
}

async fn wait_for_staged(rx: std::sync::mpsc::Receiver<u64>, count: usize) {
    tokio::task::spawn_blocking(move || {
        for _ in 0..count {
            rx.recv().expect("the gateway is running");
        }
    })
    .await
    .expect("the staged waiter");
}

async fn wait_for_committed(rx: std::sync::mpsc::Receiver<usize>, nth: usize) {
    tokio::task::spawn_blocking(
        move || {
            while rx.recv().expect("the gateway is running") < nth {}
        },
    )
    .await
    .expect("the committed waiter");
}

/// A FRAME IS STREAMED TO THE STAGED PACKFILE ON ARRIVAL (spec §4, B7, E14).
/// The body is fed by hand: the first frame whole and the second frame's header,
/// then nothing. **The first frame is written and verified on disk while the
/// body is still open**, proving the gateway streams frames incrementally rather
/// than buffering the whole HTTP body in memory; when the second frame arrives
/// and the stream closes, both frames commit together in one `.pack` file.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bundle_frame_is_committed_on_arrival_not_with_the_rest() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, phone, token) = paired(&gateway, 2).await;
    let (first, first_bytes) = part("first frame", 64 * 1024);
    let (second, second_bytes) = part("second frame", 64 * 1024);
    let length = 2 * (HEADER_LEN + 64 * 1024);
    let staged = staged_events(&gateway);

    let upload = Upload::open(&gateway, &vault, &token, length).await;
    upload.send(&frame_header(
        &first,
        &Digest::of(&first_bytes),
        first_bytes.len() as u64,
    ));
    upload.send(&first_bytes);
    upload.send(&frame_header(
        &second,
        &Digest::of(&second_bytes),
        second_bytes.len() as u64,
    ));
    wait_for_staged(staged, 1).await;
    assert_eq!(
        gateway
            .shared()
            .store()
            .staged_entries()
            .expect("staging")
            .len(),
        1,
        "the staged packfile is already on disk while the body is still open"
    );

    upload.send(&second_bytes);
    drop(upload.feed);
    let answer = upload
        .answered
        .await
        .expect("the request task")
        .expect("answered");
    assert_eq!(answer.stored(), 2);
    let missing = phone
        .exists(&vault, &[first, second])
        .await
        .expect("exists");
    assert!(missing.is_empty(), "both held once the bundle is in");
    gateway.shutdown().await;
}

/// A BODY CUT INSIDE FRAME k LEAVES FRAMES BEFORE k COMMITTED AND k ABSENT
/// (spec §4, G1, G2). Three frames are sent over a real connection: the first
/// two whole, the third's header and half its bytes. The cable is then cut.
/// After the gateway is mended, counted: two names held, the third missing, one
/// `.pack` file on disk and no staged file left once the gateway has stopped.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_cut_inside_a_frame_leaves_the_frames_before_it_committed() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, phone, token) = paired(&gateway, 4).await;
    let parts: Vec<(Name, Vec<u8>)> = (0..3)
        .map(|index| part(&format!("frame {index}"), 64 * 1024))
        .collect();
    let length = 3 * (HEADER_LEN + 64 * 1024);
    let staged = staged_events(&gateway);
    let committed = committed_events(&gateway);

    let upload = Upload::open(&gateway, &vault, &token, length).await;
    for (name, bytes) in &parts[..2] {
        upload.send(&frame_header(name, &Digest::of(bytes), bytes.len() as u64));
        upload.send(bytes);
    }
    let (cut_name, cut_bytes) = &parts[2];
    upload.send(&frame_header(
        cut_name,
        &Digest::of(cut_bytes),
        cut_bytes.len() as u64,
    ));
    upload.send(&cut_bytes[..cut_bytes.len() / 2]);
    wait_for_staged(staged, 2).await;

    gateway.cable().cut();
    assert!(
        upload.answered.await.expect("the request task").is_none(),
        "a cut body is not answered"
    );
    wait_for_committed(committed, 2).await;
    gateway.cable().mend();

    let names: Vec<Name> = parts.iter().map(|(name, _)| *name).collect();
    let missing = phone.exists(&vault, &names).await.expect("exists");
    assert_eq!(
        missing,
        vec![*cut_name],
        "frames before the cut are held; the cut one is absent"
    );
    gateway.shutdown().await;
    let on_disk = |sub: &str| {
        let root = dir.path().join(sub);
        let mut count = 0;
        let mut stack = vec![root];
        while let Some(path) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&path) else {
                continue;
            };
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    stack.push(entry.path());
                } else {
                    count += 1;
                }
            }
        }
        count
    };
    assert_eq!(
        on_disk("packs"),
        1,
        "one packfile holds both committed frames"
    );
    assert_eq!(
        on_disk("staging"),
        0,
        "the cut frame's staged bytes are gone"
    );
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
    assert_eq!(answer.stored(), COUNT, "every part is stored");
    assert_eq!(answer.results.len(), COUNT, "one result per part");

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
