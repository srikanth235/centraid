//! The seat socket, end to end, against the real binary (#1020 wave 3 lane F).
//!
//! Everything here drives `centraid seat` as a **child process over a real
//! Unix socket**: the handshake, the peer check's live half, a named read, the
//! capability mint, the blob door's seek-while-arriving case, and what quit
//! does. The unit tests beside each module prove the arithmetic; this file
//! proves the wiring, which is where the census says the bugs live (§F9's
//! "wiring tests that exist because the wiring is the bug").
//!
//! The fixture vault is founded with `centraid_vault` directly rather than by
//! running `centraid gateway`, because a gateway runs until Ctrl-C and this
//! test wants a file, not a daemon.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use centraid_protocol::framing;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;

fn binary() -> PathBuf {
    let mut path = std::env::current_exe().expect("the test binary's path");
    path.pop();
    if path.ends_with("deps") {
        path.pop();
    }
    path.join("centraid")
}

/// Found a vault under `<dir>/vault/<vaultId>/vault.db`, the layout
/// `cmd::sole_vault_file` reads.
fn found_vault(dir: &Path) -> String {
    use centraid_vault::file::Vault;

    let staging = dir.join("vault").join(".founding");
    std::fs::create_dir_all(&staging).expect("a staging directory");
    let staged = staging.join("vault.db");
    let vault = Vault::create(&staged).expect("a vault");
    let founded = vault.found("Fixture", "Owner").expect("a founding");
    drop(vault);
    let home = dir.join("vault").join(&founded.vault_id);
    std::fs::rename(&staging, &home).expect("moved into place");
    founded.vault_id
}

struct Sidecar {
    child: Child,
    socket: PathBuf,
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// Spawn the seat and wait for the ready line it prints on stdout.
///
/// **`stdio` is piped, never `ignore`** (census §F seam 3): under `ignore` a
/// child's real failure is invisible and surfaces only as a timeout waiting for
/// a line that never comes. Here the line IS the contract, and the child's
/// stderr is echoed on a failure so the reason reaches the test log.
fn spawn_seat(dir: &Path, nonce: &str, extra: &[&str]) -> (Sidecar, String) {
    let socket = dir.join("seat.sock");
    let nonce_file = dir.join("nonce");
    std::fs::write(&nonce_file, nonce).expect("a nonce file");
    let mut child = Command::new(binary())
        .args([
            "seat",
            "--data-dir",
            dir.to_str().expect("utf8"),
            "--socket",
            socket.to_str().expect("utf8"),
            "--nonce-file",
            nonce_file.to_str().expect("utf8"),
        ])
        .args(extra)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn centraid seat");
    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).expect("a ready line");
    assert!(
        line.starts_with("centraid seat ready"),
        "the seat did not announce itself: {line:?}"
    );
    (Sidecar { child, socket }, line)
}

async fn attach(socket: &Path, message: &serde_json::Value) -> UnixStream {
    let mut stream = UnixStream::connect(socket).await.expect("connected");
    send(&mut stream, message).await;
    stream
}

async fn send(stream: &mut UnixStream, message: &serde_json::Value) {
    let payload = serde_json::to_vec(message).expect("encoded");
    let mut body = vec![0x01_u8];
    body.extend_from_slice(&payload);
    framing::write_frame(stream, &body).await.expect("written");
    stream.flush().await.expect("flushed");
}

async fn recv(stream: &mut UnixStream) -> serde_json::Value {
    let body = tokio::time::timeout(Duration::from_secs(20), framing::read_frame(stream))
        .await
        .expect("a reply arrived")
        .expect("a frame")
        .expect("the stream did not end");
    assert_eq!(body[0], 0x01, "the reply is on the local channel");
    serde_json::from_slice(&body[1..]).expect("the reply is JSON")
}

fn hello(nonce: &str) -> serde_json::Value {
    serde_json::json!({ "t": "hello", "client": "renderer", "nonce": nonce, "protocol": 1 })
}

#[tokio::test(flavor = "multi_thread")]
async fn the_shell_attaches_reads_a_named_page_and_terminates_the_seat() {
    let dir = tempfile::tempdir().expect("a temp dir");
    found_vault(dir.path());
    let (mut seat, ready) = spawn_seat(dir.path(), "nonce-one", &[]);
    assert!(ready.contains("mode=replicated"), "{ready}");

    let mut stream = attach(&seat.socket, &hello("nonce-one")).await;
    let answer = recv(&mut stream).await;
    assert_eq!(answer["t"], "hello_ok");
    assert_eq!(answer["instance"], "nonce-one");
    assert_eq!(answer["mode"], "replicated");
    assert_eq!(answer["protocol"], 1);

    // THE FOUR STATES, as one message.
    send(
        &mut stream,
        &serde_json::json!({ "t": "subscribe_state", "id": 1 }),
    )
    .await;
    let state = recv(&mut stream).await;
    assert_eq!(state["t"], "state");
    let inner = &state["state"];
    // A replicated seat with a file reads locally, and has chosen no gateway
    // yet — `unconfigured`, never `offline`.
    assert_eq!(inner["availability"], "local");
    assert_eq!(inner["connectivity"], "unconfigured");
    assert_eq!(inner["mode"], "replicated");
    assert!(inner["pending_work"]["outbox"].is_number());

    // A NAMED read. The vault was just founded, so `tally.vault` has the one
    // row the founding wrote and `tally.friends` has none.
    send(
        &mut stream,
        &serde_json::json!({ "t": "page", "id": 2, "statement": "tally.vault", "limit": 10 }),
    )
    .await;
    let page = recv(&mut stream).await;
    assert_eq!(page["t"], "page");
    assert_eq!(page["columns"][0], "vault_id");
    assert_eq!(
        page["rows"].as_array().expect("rows").len(),
        1,
        "a founded vault has exactly one vault row: {page}"
    );

    // A statement nobody shipped is refused BY NAME, and the connection
    // survives it: one bad read must not cost the shell its socket.
    send(
        &mut stream,
        &serde_json::json!({
            "t": "page", "id": 3,
            "statement": "SELECT * FROM core_party", "limit": 1
        }),
    )
    .await;
    let refusal = recv(&mut stream).await;
    assert_eq!(refusal["t"], "error");
    assert_eq!(refusal["code"], "unknown-statement");

    send(
        &mut stream,
        &serde_json::json!({ "t": "page", "id": 4, "statement": "photos.assets", "limit": 5 }),
    )
    .await;
    let page = recv(&mut stream).await;
    assert_eq!(page["t"], "page");
    assert!(page["rows"].as_array().expect("rows").is_empty());

    // WHAT QUIT DOES: the terminal command, answered, then `closing`, then the
    // process exits 0 on its own — before any signal.
    send(
        &mut stream,
        &serde_json::json!({ "t": "terminate", "id": 9 }),
    )
    .await;
    let answered = recv(&mut stream).await;
    assert_eq!(answered["t"], "result");
    assert_eq!(answered["value"]["terminating"], true);
    let closing = recv(&mut stream).await;
    assert_eq!(closing["t"], "closing");

    // `try_wait` and not `/proc/<pid>`: an exited-but-unreaped child is a
    // zombie, and `/proc/<pid>` still exists for one. Polling rather than
    // `wait()` so a wedged seat fails as a timeout with a reason.
    let mut code = None;
    for _ in 0..100 {
        if let Some(status) = seat.child.try_wait().expect("try_wait") {
            code = status.code();
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        code,
        Some(0),
        "a terminated seat exits 0 of its own accord, before any signal"
    );
    // The seat unlinks the socket it bound, so the next launch has no stale
    // file to probe.
    assert!(!seat.socket.exists(), "the socket file was left behind");
}

/// THE PEER CHECK'S LIVE HALF and the handshake's refusal table, over a real
/// socket. A second uid cannot be created in this container, so what is
/// asserted here is the other three refusals plus the socket's own mode —
/// `peer::judge_peer`'s unit test names the second uid directly.
#[tokio::test(flavor = "multi_thread")]
async fn the_socket_is_0600_and_a_foreign_instance_is_refused_not_adopted() {
    use std::os::unix::fs::PermissionsExt as _;

    let dir = tempfile::tempdir().expect("a temp dir");
    found_vault(dir.path());
    let (seat, _) = spawn_seat(dir.path(), "nonce-two", &[]);

    let mode = std::fs::metadata(&seat.socket)
        .expect("the socket exists")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "the socket is group- or world-reachable");

    // ANOTHER INSTALL'S SHELL: refused, and told which refusal it is.
    let mut stream = attach(&seat.socket, &hello("somebody-elses-nonce")).await;
    let refusal = recv(&mut stream).await;
    assert_eq!(refusal["t"], "refused");
    assert_eq!(refusal["code"], "foreign-instance");
    assert!(
        refusal["message"]
            .as_str()
            .expect("a sentence")
            .contains("different Centraid install"),
        "{refusal}"
    );

    // A build mismatch is its own code, never "bad nonce".
    let mut stream = UnixStream::connect(&seat.socket).await.expect("connected");
    send(
        &mut stream,
        &serde_json::json!({
            "t": "hello", "client": "renderer", "nonce": "nonce-two", "protocol": 99
        }),
    )
    .await;
    assert_eq!(recv(&mut stream).await["code"], "protocol-mismatch");

    // A child with no token is refused, and the sentence tells the operator
    // what is missing rather than "invalid".
    let mut stream = UnixStream::connect(&seat.socket).await.expect("connected");
    send(
        &mut stream,
        &serde_json::json!({ "t": "hello", "client": "mcp", "protocol": 1 }),
    )
    .await;
    assert_eq!(recv(&mut stream).await["code"], "token-missing");

    // Anything before a hello.
    let mut stream = UnixStream::connect(&seat.socket).await.expect("connected");
    send(
        &mut stream,
        &serde_json::json!({ "t": "devices_list", "id": 1 }),
    )
    .await;
    assert_eq!(recv(&mut stream).await["code"], "handshake-expected");
}

/// `centraid mcp` and the browser host attach with a **per-turn capability
/// token** the shell minted, and the token is single-use (D-1020-AS2).
#[tokio::test(flavor = "multi_thread")]
async fn a_second_local_client_kind_attaches_with_a_minted_token_once() {
    let dir = tempfile::tempdir().expect("a temp dir");
    found_vault(dir.path());
    let (seat, _) = spawn_seat(dir.path(), "nonce-three", &[]);

    let mut shell = attach(&seat.socket, &hello("nonce-three")).await;
    assert_eq!(recv(&mut shell).await["t"], "hello_ok");
    send(
        &mut shell,
        &serde_json::json!({
            "t": "mint_capability", "id": 1, "client": "mcp",
            "purpose": "one agent turn", "ttl_ms": 60000
        }),
    )
    .await;
    let minted = recv(&mut shell).await;
    assert_eq!(minted["t"], "result");
    let token = minted["value"]["token"]
        .as_str()
        .expect("a token")
        .to_owned();
    assert_eq!(token.len(), 64);

    // The child attaches with it.
    let mut child = UnixStream::connect(&seat.socket).await.expect("connected");
    send(
        &mut child,
        &serde_json::json!({ "t": "hello", "client": "mcp", "token": token, "protocol": 1 }),
    )
    .await;
    assert_eq!(recv(&mut child).await["t"], "hello_ok");
    // And it can read, through the same catalogue the shell uses.
    send(
        &mut child,
        &serde_json::json!({ "t": "page", "id": 1, "statement": "tally.vault", "limit": 1 }),
    )
    .await;
    assert_eq!(recv(&mut child).await["t"], "page");

    // SPENT: a second child with the same token gets nothing.
    let mut replay = UnixStream::connect(&seat.socket).await.expect("connected");
    send(
        &mut replay,
        &serde_json::json!({ "t": "hello", "client": "mcp", "token": token, "protocol": 1 }),
    )
    .await;
    assert_eq!(recv(&mut replay).await["code"], "token-unknown");

    // A CHILD MAY NOT MINT. Only the shell does, and a child that could would
    // make the token decorative.
    let mut shell2 = attach(&seat.socket, &hello("nonce-three")).await;
    assert_eq!(recv(&mut shell2).await["t"], "hello_ok");
    send(
        &mut shell2,
        &serde_json::json!({
            "t": "mint_capability", "id": 2, "client": "native-host",
            "purpose": "a browser turn", "ttl_ms": 1000
        }),
    )
    .await;
    let minted = recv(&mut shell2).await;
    let host_token = minted["value"]["token"]
        .as_str()
        .expect("a token")
        .to_owned();
    let mut host = UnixStream::connect(&seat.socket).await.expect("connected");
    send(
        &mut host,
        &serde_json::json!({
            "t": "hello", "client": "native-host", "token": host_token, "protocol": 1
        }),
    )
    .await;
    assert_eq!(recv(&mut host).await["t"], "hello_ok");
    send(
        &mut host,
        &serde_json::json!({
            "t": "mint_capability", "id": 1, "client": "mcp",
            "purpose": "escalation", "ttl_ms": 1000
        }),
    )
    .await;
    assert_eq!(recv(&mut host).await["code"], "not-permitted");
}

/// **THE EXIT CRITERION, at the socket.** A blob that is still being written is
/// stat-ed, read inside its prefix, read *short* across the prefix's end, and
/// seeked past it — where the seat waits for the writer rather than refusing.
///
/// The `<video>` half of the same claim is the Playwright run in
/// `desktop/e2e/media-seek.spec.ts`; this is the same behaviour one layer down,
/// where a failure names the frame that was wrong.
#[tokio::test(flavor = "multi_thread")]
async fn a_blob_still_arriving_serves_its_prefix_and_a_seek_waits_for_the_writer() {
    let dir = tempfile::tempdir().expect("a temp dir");
    found_vault(dir.path());
    let blobs = dir.path().join("blobs");
    std::fs::create_dir_all(&blobs).expect("a blob root");
    let digest = "0".repeat(64);
    let total = 4_096_u64;
    let partial = blobs.join(format!("{digest}.partial"));
    std::fs::write(&partial, vec![b'a'; 512]).expect("a prefix");
    std::fs::write(blobs.join(format!("{digest}.total")), total.to_string()).expect("a total");
    std::fs::write(blobs.join(format!("{digest}.type")), "video/mp4").expect("a type");

    let (seat, _) = spawn_seat(dir.path(), "nonce-four", &[]);
    let mut stream = attach(&seat.socket, &hello("nonce-four")).await;
    assert_eq!(recv(&mut stream).await["t"], "hello_ok");

    send(
        &mut stream,
        &serde_json::json!({ "t": "blob_stat", "id": 1, "blob": digest }),
    )
    .await;
    let stat = recv(&mut stream).await;
    assert_eq!(stat["t"], "blob_stat");
    assert_eq!(stat["total"], total);
    assert_eq!(stat["received"], 512);
    assert_eq!(stat["complete"], false);
    assert_eq!(stat["media_type"], "video/mp4");
    assert_eq!(stat["inline"], true);

    // Inside the prefix.
    send(
        &mut stream,
        &serde_json::json!({
            "t": "blob_range", "id": 2, "blob": digest, "range": "bytes=0-99", "wait_ms": 1
        }),
    )
    .await;
    let bytes = recv(&mut stream).await;
    assert_eq!(bytes["t"], "blob_bytes");
    assert_eq!(bytes["start"], 0);
    assert_eq!(bytes["end"], 99);
    assert_eq!(bytes["total"], total);
    assert_eq!(bytes["partial"], true);

    // ACROSS THE PREFIX'S END: served SHORT, not zero-padded.
    send(
        &mut stream,
        &serde_json::json!({
            "t": "blob_range", "id": 3, "blob": digest, "range": "bytes=256-1023", "wait_ms": 1
        }),
    )
    .await;
    let bytes = recv(&mut stream).await;
    assert_eq!(bytes["t"], "blob_bytes");
    assert_eq!(bytes["start"], 256);
    assert_eq!(bytes["end"], 511, "the seat served past what had arrived");

    // A SEEK PAST THE WRITE HEAD, with nothing more written: "not yet", and
    // NEVER `unsatisfiable` — a 416 would end playback permanently.
    send(
        &mut stream,
        &serde_json::json!({
            "t": "blob_range", "id": 4, "blob": digest, "range": "bytes=2048-2147", "wait_ms": 100
        }),
    )
    .await;
    let answer = recv(&mut stream).await;
    assert_eq!(answer["t"], "error");
    assert_eq!(answer["code"], "still-arriving");

    // THE SAME SEEK, with a writer appending: the seat waits and answers bytes.
    let writer = std::thread::spawn({
        let partial = partial.clone();
        move || {
            std::thread::sleep(Duration::from_millis(150));
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&partial)
                .expect("append");
            file.write_all(&vec![b'b'; 3_584]).expect("wrote the rest");
        }
    });
    send(
        &mut stream,
        &serde_json::json!({
            "t": "blob_range", "id": 5, "blob": digest, "range": "bytes=2048-2147", "wait_ms": 5000
        }),
    )
    .await;
    let bytes = recv(&mut stream).await;
    writer.join().expect("the writer finished");
    assert_eq!(bytes["t"], "blob_bytes", "the seek was refused: {bytes}");
    assert_eq!(bytes["start"], 2_048);
    assert_eq!(bytes["end"], 2_147);
    use base64::Engine as _;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(bytes["bytes_b64"].as_str().expect("base64"))
        .expect("decodes");
    assert_eq!(decoded.len(), 100);
    // The bytes at that offset are the writer's, not zeros: a clamp that read
    // off the end of the file would hand back a corrupt frame.
    assert!(decoded.iter().all(|byte| *byte == b'b'), "{decoded:?}");

    // Past the DECLARED total is the one 416.
    send(
        &mut stream,
        &serde_json::json!({
            "t": "blob_range", "id": 6, "blob": digest, "range": "bytes=9000-9100"
        }),
    )
    .await;
    let answer = recv(&mut stream).await;
    assert_eq!(answer["code"], "unsatisfiable");

    // A blob nobody has is `not-found`, never an empty body.
    send(
        &mut stream,
        &serde_json::json!({ "t": "blob_stat", "id": 7, "blob": "f".repeat(64) }),
    )
    .await;
    assert_eq!(recv(&mut stream).await["code"], "not-found");
}

/// A thin seat serves the **same** socket surface and says so in its state:
/// `unavailable` with no gateway, which the shell draws as "nothing to show"
/// and never as an empty list.
#[tokio::test(flavor = "multi_thread")]
async fn a_thin_seat_has_the_same_door_and_a_different_state() {
    let dir = tempfile::tempdir().expect("a temp dir");
    found_vault(dir.path());
    let (seat, ready) = spawn_seat(dir.path(), "nonce-five", &["--thin"]);
    assert!(ready.contains("mode=thin"), "{ready}");

    let mut stream = attach(&seat.socket, &hello("nonce-five")).await;
    let answer = recv(&mut stream).await;
    assert_eq!(answer["mode"], "thin");
    send(
        &mut stream,
        &serde_json::json!({ "t": "subscribe_state", "id": 1 }),
    )
    .await;
    let inner = recv(&mut stream).await["state"].clone();
    assert_eq!(inner["availability"], "unavailable");
    assert_eq!(inner["durability"], "none");
    assert_eq!(inner["mode"], "thin");

    // And the door is identical: the same message, refused with a reason
    // rather than answered with an empty page, because a thin seat that cannot
    // reach its gateway knows nothing about what the vault holds.
    send(
        &mut stream,
        &serde_json::json!({ "t": "page", "id": 2, "statement": "tally.vault", "limit": 1 }),
    )
    .await;
    let answer = recv(&mut stream).await;
    assert_eq!(
        answer["t"], "error",
        "a thin seat must not fabricate a page"
    );
    assert_eq!(answer["code"], "refused");
}

/// A second launch of the shell adopts the seat that is already serving rather
/// than binding over it — and a socket nothing is listening on is unlinked.
#[tokio::test(flavor = "multi_thread")]
async fn a_second_launch_adopts_and_a_stale_file_is_unlinked() {
    let dir = tempfile::tempdir().expect("a temp dir");
    found_vault(dir.path());
    let (seat, _) = spawn_seat(dir.path(), "nonce-six", &[]);

    let nonce_file = dir.path().join("nonce");
    let second = Command::new(binary())
        .args([
            "seat",
            "--data-dir",
            dir.path().to_str().expect("utf8"),
            "--socket",
            seat.socket.to_str().expect("utf8"),
            "--nonce-file",
            nonce_file.to_str().expect("utf8"),
        ])
        .output()
        .expect("a second seat");
    assert_eq!(second.status.code(), Some(0), "a second launch is harmless");
    let stdout = String::from_utf8_lossy(&second.stdout);
    assert!(stdout.contains("adopted"), "{stdout}");
    // The first seat is untouched.
    assert!(seat.socket.exists());

    // A STALE FILE: the shape a crashed seat leaves behind.
    let stale_dir = tempfile::tempdir().expect("a temp dir");
    found_vault(stale_dir.path());
    std::fs::write(stale_dir.path().join("seat.sock"), b"leftover").expect("a stale file");
    let (adopted, ready) = spawn_seat(stale_dir.path(), "nonce-seven", &[]);
    assert!(ready.contains("socket="), "{ready}");
    drop(adopted);
}

/// The **core channel**: a `centraid.core.v1.Envelope`, byte-identical to what
/// crosses iroh, over the same socket.
///
/// This is the path `centraid mcp` and any future native client take, and it is
/// what makes the local channel's JSON a convenience rather than a second
/// protocol: the version-bearing surface is unchanged and is exercised here.
#[tokio::test(flavor = "multi_thread")]
async fn the_core_channel_carries_an_envelope_unchanged() {
    use centraid_api_proto::core_v1 as wire;
    use prost::Message as _;

    let dir = tempfile::tempdir().expect("a temp dir");
    found_vault(dir.path());
    let (seat, _) = spawn_seat(dir.path(), "nonce-eight", &[]);
    let mut stream = attach(&seat.socket, &hello("nonce-eight")).await;
    assert_eq!(recv(&mut stream).await["t"], "hello_ok");

    let envelope = wire::Envelope {
        request_id: 7,
        body: Some(wire::envelope::Body::Request(wire::Request {
            kind: Some(wire::request::Kind::Hello(wire::Hello {
                schema_version: 1,
                min_supported: 1,
                product_version: "a test".to_owned(),
                capabilities: Vec::new(),
            })),
        })),
    };
    let mut body = vec![0x00_u8];
    body.extend_from_slice(&envelope.encode_to_vec());
    framing::write_frame(&mut stream, &body)
        .await
        .expect("written");
    stream.flush().await.expect("flushed");

    let reply = tokio::time::timeout(Duration::from_secs(10), framing::read_frame(&mut stream))
        .await
        .expect("a reply arrived")
        .expect("a frame")
        .expect("the stream did not end");
    assert_eq!(
        reply[0], 0x00,
        "a core request is answered on the core channel"
    );
    let decoded = wire::Envelope::decode(&reply[1..]).expect("an envelope");
    // ANSWERED UNDER THE PEER'S OWN ID: the client minted 7, and a core that
    // answered under an id it minted itself would be unmatchable.
    assert_eq!(decoded.request_id, 7);
    let Some(wire::envelope::Body::Response(wire::Response {
        kind: Some(wire::response::Kind::Hello(hello)),
    })) = decoded.body
    else {
        panic!("expected a Hello response, got {decoded:?}");
    };
    assert_eq!(hello.schema_version, 1);

    // A RESPONSE FROM A CLIENT is answered with `Unsupported`, never dropped
    // (#1020 Compatibility).
    let stray = wire::Envelope {
        request_id: 8,
        body: Some(wire::envelope::Body::Event(wire::Event { kind: None })),
    };
    let mut body = vec![0x00_u8];
    body.extend_from_slice(&stray.encode_to_vec());
    framing::write_frame(&mut stream, &body)
        .await
        .expect("written");
    stream.flush().await.expect("flushed");
    let reply = tokio::time::timeout(Duration::from_secs(10), framing::read_frame(&mut stream))
        .await
        .expect("a reply arrived")
        .expect("a frame")
        .expect("the stream did not end");
    let decoded = wire::Envelope::decode(&reply[1..]).expect("an envelope");
    assert!(matches!(
        decoded.body,
        Some(wire::envelope::Body::Response(wire::Response {
            kind: Some(wire::response::Kind::Unsupported(_))
        }))
    ));
}
