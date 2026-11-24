//! THE BUNDLE IS THE ONE WAY IN, AND EACH FRAME ANSWERS FOR ITSELF
//! (#1209, spec §4, G1 and G2), over a real gateway on a real socket.
//!
//! `PUT /v1/v/{vault}/o/{name}` is gone: a request for it is answered like any
//! route that does not exist. A frame is answered `stored`, `there`, `held`,
//! `taken`, `full` or `too_large` on its own, and a refused frame never stops
//! the frames after it. Counted, never timed.

use centraid_gateway::rules::bundle::Frame;
use centraid_gateway::rules::code::{Code, RefusalBody};
use centraid_gateway::rules::ids::{Digest, Name, VaultId};
use centraid_gateway::rules::limits::MAX_OBJECT_BYTES;
use centraid_gateway::rules::wire::FrameResult;
use centraid_gateway::server::harness::{Spawned, pair_secret, put, spawn};

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
        .body(Full::new(bytes::Bytes::from(body)))
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
        gateway.shared().store().files().expect("lists").is_empty(),
        "and left no file"
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
/// is read past and `too_large`, and the frames either side of it are stored.
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
    assert_eq!(gateway.shared().store().files().expect("lists").len(), 0);
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
    // A frame at exactly the cap is accepted.
    let at_cap_name = Name::from_bytes([0x78; 32]);
    let at_cap = vec![6_u8; usize::try_from(MAX_OBJECT_BYTES).expect("fits")];
    let answer = phone
        .bundle(&vault, &[Frame::of(at_cap_name, at_cap)])
        .await
        .expect("answers");
    assert_eq!(answer.stored(), 1, "{answer:?}");
    gateway.shutdown().await;
}

/// G1: A FRAME THAT IS NOT ITS DIGEST IS REFUSED, AND THE REST GO ON. The
/// frame's bytes are hashed as they arrive; a frame that does not hash to the
/// digest it named stores nothing and answers `DIGEST_MISMATCH`, and the frame
/// after it is stored.
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
    assert_eq!(
        phone
            .exists(&vault, &[lying.name, honest.name])
            .await
            .expect("exists"),
        vec![lying.name]
    );
    gateway.shutdown().await;
}
