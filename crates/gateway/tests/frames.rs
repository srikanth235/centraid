//! THE BUNDLE IS THE ONE WAY IN, EACH FRAME ANSWERS FOR ITSELF, AND A STREAM
//! CUT MID-FRAME STILL COMMITS COMPLETED FRAMES BEFORE THE CUT
//! (#1209, #1212, spec §4, G1 and G2), over a real gateway on a real socket.

use bytes::Bytes;
use centraid_gateway::rules::bundle::{Frame, HEADER_LEN, header as frame_header};
use centraid_gateway::rules::code::{Code, RefusalBody};
use centraid_gateway::rules::ids::{Digest, Name, VaultId};
use centraid_gateway::rules::limits::MAX_OBJECT_BYTES;
use centraid_gateway::rules::wire::{BundleAnswer, FrameResult};
use centraid_gateway::server::harness::{Spawned, pair_secret, put, spawn};
use futures::StreamExt as _;

async fn paired(gateway: &Spawned) -> (VaultId, centraid_gateway::client::Client) {
    let key = ed25519_dalek::SigningKey::from_bytes(&[41; 32]);
    let paired = pair_secret(
        &gateway.first_contact(),
        &key,
        "a phone",
        gateway.mint_pairing_secret(),
    )
    .await
    .expect("pairs");
    (
        VaultId::from_bytes(key.verifying_key().to_bytes()),
        gateway.client(paired.token),
    )
}

fn frame(label: &str) -> Frame {
    let name = Name::from_bytes(blake3::derive_key("frames name", label.as_bytes()));
    Frame::of(name, blake3::hash(label.as_bytes()).as_bytes().repeat(8))
}

/// A bare HTTPS request over HTTP/1.1, not ours: the status and the code the
/// gateway answered.
async fn raw(
    gateway: &Spawned,
    token: &str,
    method: &str,
    path: &str,
    body: Vec<u8>,
) -> (u16, Option<Code>) {
    use http_body_util::{BodyExt as _, Full};
    use hyper_util::rt::TokioIo;
    use tokio_rustls::TlsConnector;
    use tokio_rustls::rustls::pki_types::ServerName;

    let socket = tokio::net::TcpStream::connect(gateway.addr)
        .await
        .expect("connects");
    let tls = TlsConnector::from(centraid_gateway::client::tls::client_config(
        centraid_gateway::client::tls::Trust::Certificate(gateway.cert_der.clone()),
    ))
    .connect(ServerName::try_from("localhost").expect("a name"), socket)
    .await
    .expect("handshakes");
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(tls))
        .await
        .expect("speaks HTTP/1.1");
    tokio::spawn(connection);
    let request = hyper::Request::builder()
        .method(method)
        .uri(path)
        .header("host", gateway.addr.to_string())
        .header("authorization", format!("Bearer {token}"))
        .header("content-length", body.len())
        .body(Full::new(Bytes::from(body)))
        .expect("a request");
    let response = sender.send_request(request).await.expect("answered");
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.expect("a body");
    let code = serde_json::from_slice::<RefusalBody>(&bytes.to_bytes())
        .ok()
        .map(|body| body.code);
    (status, code)
}

/// G2: THE PUT ROUTE IS GONE. A token that is good for everything else is
/// answered `404 NOT_FOUND` for a `PUT` of an object, and nothing is stored;
/// the same name sent as a frame is stored.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_put_of_an_object_is_answered_not_found_and_stores_nothing() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let key = ed25519_dalek::SigningKey::from_bytes(&[42; 32]);
    let paired = pair_secret(
        &gateway.first_contact(),
        &key,
        "a phone",
        gateway.mint_pairing_secret(),
    )
    .await
    .expect("pairs");
    let vault = VaultId::from_bytes(key.verifying_key().to_bytes());
    let phone = gateway.client(paired.token);
    let one = frame("a put that is no route");
    let path = format!("/v1/v/{vault}/o/{}", one.name);

    let (status, code) = raw(
        &gateway,
        &paired.token.to_string(),
        "PUT",
        &path,
        one.bytes.clone(),
    )
    .await;
    assert_eq!((status, code), (404, Some(Code::NotFound)));
    assert_eq!(
        phone.exists(&vault, &[one.name]).await.expect("exists"),
        vec![one.name],
        "the PUT stored nothing"
    );
    assert!(
        gateway
            .shared()
            .store()
            .pack_files()
            .expect("lists")
            .is_empty(),
        "and left no packfile"
    );

    let answer = phone
        .bundle(&vault, std::slice::from_ref(&one))
        .await
        .expect("stores");
    assert_eq!(answer.stored(), 1);
    // GET of the same path is still a route.
    assert_eq!(
        phone.get(&vault, &one.name, None).await.expect("reads"),
        one.bytes
    );
    gateway.shutdown().await;
}

/// G1: A FULL DISK AND A FRAME OVER THE CAP ARE ANSWERED PER FRAME. With the
/// disk pretending to be full, every frame is `full` and nothing is stored;
/// mended, the same frames are `stored`. A frame one byte over the object cap
/// (`MAX_OBJECT_BYTES = 4,194,355` for `CSB4`) is read past and `too_large`,
/// and the frames either side of it are stored.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_and_too_large_are_answered_for_the_frame_alone() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, phone) = paired(&gateway).await;
    let frames = [frame("first"), frame("second")];

    gateway.fill_disk(true);
    let answer = phone.bundle(&vault, &frames).await.expect("answers");
    assert_eq!(
        answer.results,
        vec![
            FrameResult::Full {
                name: frames[0].name
            },
            FrameResult::Full {
                name: frames[1].name
            }
        ]
    );
    assert_eq!(
        gateway.shared().store().pack_files().expect("lists").len(),
        0
    );
    gateway.fill_disk(false);
    let answer = phone.bundle(&vault, &frames).await.expect("answers");
    assert_eq!(answer.stored(), 2);

    let big_name = Name::from_bytes([0x77; 32]);
    let big = vec![5_u8; usize::try_from(MAX_OBJECT_BYTES).expect("fits") + 1];
    let (before, after) = (frame("before the big one"), frame("after the big one"));
    let answer = phone
        .bundle(
            &vault,
            &[before.clone(), Frame::of(big_name, big), after.clone()],
        )
        .await
        .expect("answers");
    assert_eq!(
        answer.results,
        vec![
            FrameResult::Stored { name: before.name },
            FrameResult::TooLarge { name: big_name },
            FrameResult::Stored { name: after.name },
        ]
    );
    // A frame at exactly the CSB4 cap (4_194_355 bytes) is accepted.
    let at_cap_name = Name::from_bytes([0x78; 32]);
    let at_cap = vec![6_u8; usize::try_from(MAX_OBJECT_BYTES).expect("fits")];
    let answer = phone
        .bundle(&vault, &[Frame::of(at_cap_name, at_cap)])
        .await
        .expect("answers");
    assert_eq!(answer.stored(), 1, "{answer:?}");
    gateway.shutdown().await;
}

/// G1: A FRAME THAT IS NOT ITS DIGEST IS REFUSED AND TRUNCATED OUT OF THE PACK,
/// AND SUBSEQUENT FRAMES CONTINUE CLEANLY.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_frame_that_is_not_its_digest_stores_nothing_and_the_next_goes_on() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let (vault, phone) = paired(&gateway).await;
    let (lying, honest) = (frame("lying"), frame("honest"));
    let answer = put(
        &phone,
        &vault,
        &lying.name,
        &Digest::of(b"other bytes"),
        lying.bytes.clone(),
    )
    .await
    .expect("answers");
    assert_eq!(
        answer,
        FrameResult::Refused {
            name: lying.name,
            code: Code::DigestMismatch
        }
    );
    assert!(
        gateway
            .shared()
            .store()
            .pack_files()
            .expect("lists")
            .is_empty(),
        "a single mismatched frame leaves no packfile"
    );

    let answer = phone
        .bundle(
            &vault,
            &[
                Frame {
                    name: lying.name,
                    digest: Digest::of(b"other bytes"),
                    bytes: lying.bytes.clone(),
                },
                honest.clone(),
            ],
        )
        .await
        .expect("answers");
    assert_eq!(answer.results.len(), 2);
    assert_eq!(answer.stored(), 1);
    let packs = gateway.shared().store().pack_files().expect("lists");
    assert_eq!(packs.len(), 1);
    assert_eq!(
        packs[0].len,
        honest.bytes.len() as u64,
        "lying frame bytes were truncated out of the packfile before commit"
    );
    assert_eq!(
        phone
            .exists(&vault, &[lying.name, honest.name])
            .await
            .expect("exists"),
        vec![lying.name]
    );
    assert_eq!(
        phone.get(&vault, &honest.name, None).await.expect("reads"),
        honest.bytes
    );
    gateway.shutdown().await;
}

/// G2: A BUNDLE STREAM CUT MID-FRAME TRUNCATES PARTIAL TRAILING BYTES AND
/// COMMITS ALL COMPLETED VALID FRAMES BEFORE THE CUT IN ONE PACKFILE.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bundle_cut_mid_stream_commits_completed_frames_before_the_cut() {
    use http_body_util::{BodyExt as _, StreamBody};
    use hyper_util::rt::TokioIo;
    use tokio_rustls::TlsConnector;
    use tokio_rustls::rustls::pki_types::ServerName;

    let dir = tempfile::tempdir().expect("a temp dir");
    let gateway = spawn(dir.path()).await.expect("spawned");
    let key = ed25519_dalek::SigningKey::from_bytes(&[43; 32]);
    let paired = pair_secret(
        &gateway.first_contact(),
        &key,
        "a phone",
        gateway.mint_pairing_secret(),
    )
    .await
    .expect("pairs");
    let vault = VaultId::from_bytes(key.verifying_key().to_bytes());
    let phone = gateway.client(paired.token);

    let f0 = Frame::of(Name::from_bytes([0x10; 32]), vec![0xa1; 32 * 1024]);
    let f1 = Frame::of(Name::from_bytes([0x11; 32]), vec![0xb2; 48 * 1024]);
    let f2 = Frame::of(Name::from_bytes([0x12; 32]), vec![0xc3; 64 * 1024]);
    let total_len = [&f0, &f1, &f2]
        .iter()
        .map(|f| HEADER_LEN + f.bytes.len())
        .sum::<usize>();

    let (staged_tx, staged_rx) = std::sync::mpsc::channel::<u64>();
    gateway
        .shared()
        .store()
        .knobs()
        .on_staged(Some(std::sync::Arc::new(move |size| {
            let _ = staged_tx.send(size);
        })));
    let (committed_tx, committed_rx) = std::sync::mpsc::channel::<usize>();
    gateway
        .shared()
        .store()
        .knobs()
        .on_committed(Some(std::sync::Arc::new(move |nth| {
            let _ = committed_tx.send(nth);
        })));

    let socket = tokio::net::TcpStream::connect(gateway.addr)
        .await
        .expect("connects");
    let tls = TlsConnector::from(centraid_gateway::client::tls::client_config(
        centraid_gateway::client::tls::Trust::Certificate(gateway.cert_der.clone()),
    ))
    .connect(ServerName::try_from("localhost").expect("a name"), socket)
    .await
    .expect("handshakes");
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(tls))
        .await
        .expect("speaks HTTP/1.1");
    let conn_task = tokio::spawn(connection);
    let (feed, fed) = futures::channel::mpsc::unbounded::<Bytes>();
    let body =
        StreamBody::new(fed.map(|bytes| Ok::<_, std::io::Error>(hyper::body::Frame::data(bytes))));
    let request = hyper::Request::builder()
        .method("POST")
        .uri(format!("/v1/v/{vault}/bundle"))
        .header("host", gateway.addr.to_string())
        .header("authorization", format!("Bearer {}", paired.token))
        .header("content-length", total_len)
        .header("content-type", "application/octet-stream")
        .body(body)
        .expect("a request");
    let answered = tokio::spawn(async move {
        let response = sender.send_request(request).await.ok()?;
        let bytes = response.into_body().collect().await.ok()?;
        serde_json::from_slice::<BundleAnswer>(&bytes.to_bytes()).ok()
    });

    for complete in [&f0, &f1] {
        feed.unbounded_send(Bytes::copy_from_slice(&frame_header(
            &complete.name,
            &complete.digest,
            complete.bytes.len() as u64,
        )))
        .expect("sends header");
        feed.unbounded_send(Bytes::copy_from_slice(&complete.bytes))
            .expect("sends body");
    }
    feed.unbounded_send(Bytes::copy_from_slice(&frame_header(
        &f2.name,
        &f2.digest,
        f2.bytes.len() as u64,
    )))
    .expect("sends f2 header");
    feed.unbounded_send(Bytes::copy_from_slice(&f2.bytes[..f2.bytes.len() / 2]))
        .expect("sends half of f2");

    // Wait until both complete frames have been staged.
    let (f0_len, f1_len) = (f0.bytes.len() as u64, f1.bytes.len() as u64);
    tokio::task::spawn_blocking(move || {
        assert_eq!(staged_rx.recv().expect("f0 staged"), f0_len);
        assert_eq!(staged_rx.recv().expect("f1 staged"), f1_len);
    })
    .await
    .expect("staged");

    // Cut the connection mid-frame and wait for the completed frames to commit.
    gateway.cable().cut();
    drop(feed);
    conn_task.abort();
    assert!(answered.await.expect("task").is_none());
    tokio::task::spawn_blocking(move || while committed_rx.recv().expect("committed") < 2 {})
        .await
        .expect("committed");
    gateway.cable().mend();

    assert_eq!(
        phone
            .exists(&vault, &[f0.name, f1.name, f2.name])
            .await
            .expect("exists"),
        vec![f2.name],
        "f0 and f1 committed; f2 was cut and discarded"
    );
    assert_eq!(
        phone.get(&vault, &f0.name, None).await.expect("f0"),
        f0.bytes
    );
    assert_eq!(
        phone.get(&vault, &f1.name, None).await.expect("f1"),
        f1.bytes
    );

    let packs = gateway.shared().store().pack_files().expect("lists");
    assert_eq!(packs.len(), 1);
    assert_eq!(
        packs[0].len,
        (f0.bytes.len() + f1.bytes.len()) as u64,
        "partial trailing bytes of f2 were truncated before promotion"
    );
    assert!(
        gateway
            .shared()
            .store()
            .staged_entries()
            .expect("staging")
            .is_empty()
    );
    gateway.shutdown().await;
}
