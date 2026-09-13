//! THE COMPANION'S EIGHTEEN METHODS, AGAINST A REAL SEAT (#1020 wave 4 lane
//! extension).
//!
//! Everything here drives **two real child processes**: `centraid seat` over a
//! real Unix socket, and `centraid native-host` over the **browser's own
//! framing** on its stdin and stdout. Nothing is stubbed on either side, which
//! is the point: the unit tests beside each module prove the arithmetic and the
//! lowering table, and this file proves that a frame a browser would write
//! reaches the vault and comes back.
//!
//! What each test establishes:
//!
//! | Test | Claim |
//! |---|---|
//! | [`every_companion_method_is_served_by_the_host`] | all eighteen are answered; none is `unknown-method` |
//! | [`a_nineteenth_method_is_refused_by_name`] | the closed enum has teeth |
//! | [`the_browser_may_lock_the_seat_and_may_never_unlock_it`] | the phishing rule, at the socket |
//! | [`a_fill_reaches_the_seats_own_reveal_path`] | the fill frame is wired end to end |
//! | [`a_three_megabyte_capture_stages_in_frames_that_fit`] | the 1 MiB ceiling, with real frames |
//! | [`the_host_without_a_token_answers_a_member_sentence`] | no capability, no relay |

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
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

/// Found a vault under `<dir>/vault/<vaultId>/vault.db`.
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

fn spawn_seat(dir: &Path, nonce: &str) -> Sidecar {
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
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn centraid seat");
    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).expect("a ready line");
    assert!(line.starts_with("centraid seat ready"), "{line:?}");
    Sidecar { child, socket }
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

/// Attach as the shell and mint a capability token for the browser's host.
///
/// The shell is the only client that may mint (D-1020-F14), so this is also the
/// only way a host gets a token — which is why every test here goes through it
/// rather than inventing one.
async fn mint_host_token(socket: &Path, nonce: &str) -> (UnixStream, String) {
    let mut shell = UnixStream::connect(socket).await.expect("connected");
    send(
        &mut shell,
        &serde_json::json!({ "t": "hello", "client": "renderer", "nonce": nonce, "protocol": 1 }),
    )
    .await;
    assert_eq!(recv(&mut shell).await["t"], "hello_ok");
    send(
        &mut shell,
        &serde_json::json!({
            "t": "mint_capability", "id": 1, "client": "native-host",
            "purpose": "a browser port", "ttl_ms": 120_000
        }),
    )
    .await;
    let minted = recv(&mut shell).await;
    let token = minted["value"]["token"]
        .as_str()
        .expect("a token")
        .to_owned();
    (shell, token)
}

/// `centraid native-host`, driven the way a browser drives it.
struct BrowserPort {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

impl Drop for BrowserPort {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl BrowserPort {
    fn open(socket: Option<&Path>, token: Option<&str>) -> Self {
        let mut command = Command::new(binary());
        command
            .arg("native-host")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env_remove("CENTRAID_SEAT_SOCKET")
            .env_remove("CENTRAID_SEAT_TOKEN");
        if let Some(socket) = socket {
            command.env("CENTRAID_SEAT_SOCKET", socket);
        }
        if let Some(token) = token {
            command.env("CENTRAID_SEAT_TOKEN", token);
        }
        let mut child = command.spawn().expect("spawn centraid native-host");
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        Self {
            child,
            stdin,
            stdout,
        }
    }

    /// Write one frame in the browser's framing and read the answer.
    ///
    /// `u32` in the **host's** byte order, which is not the product's `u32BE` —
    /// the trap `crates/centraid/src/cmd/native_host.rs` exists to not fall
    /// into, and this helper writes it the way Chrome does so a regression to
    /// big-endian fails here.
    fn ask(&mut self, message: &serde_json::Value) -> serde_json::Value {
        let body = serde_json::to_vec(message).expect("encoded");
        self.stdin
            .write_all(&(body.len() as u32).to_ne_bytes())
            .expect("a length");
        self.stdin.write_all(&body).expect("a body");
        self.stdin.flush().expect("flushed");
        let mut length = [0_u8; 4];
        self.stdout.read_exact(&mut length).expect("a reply length");
        let mut reply = vec![0_u8; u32::from_ne_bytes(length) as usize];
        self.stdout.read_exact(&mut reply).expect("a reply body");
        serde_json::from_slice(&reply).expect("the reply is JSON")
    }
}

/// A stub input for a method, carrying every field any of the eighteen needs.
fn stub_input() -> serde_json::Value {
    serde_json::json!({
        "itemId": "no-such-item",
        "pageUrl": "https://www.bank.example/sign-in",
        "vaultId": "no-such-vault",
        "summary": "A meeting",
        "start": "2026-01-01T09:00:00Z",
        "end": "2026-01-01T10:00:00Z",
        "calendarId": "cal-1",
        "displayName": "A Person",
        "cadenceDays": 30,
        "title": "A Login",
        "username": "someone",
        "password": "a-long-enough-password",
        "ticket": "not-a-ticket",
        "grants": ["locker"],
        "staged_sha": "0".repeat(64),
        "capture": { "title": "A Page", "url": "https://example.test/a" },
    })
}

/// **THE EXIT CRITERION.** Every one of the eighteen methods is served: each
/// answers `ok` or a TYPED refusal, and not one is `unknown-method`.
///
/// A method that lands on a command no lane has registered yet answers the
/// vault's own refusal, which is the honest outcome and is exactly what
/// `relay::PENDING_COMMANDS` names. What must never happen is an unknown method
/// or a silent success, and this asserts both.
#[test]
fn every_companion_method_is_served_by_the_host() {
    let dir = tempfile::tempdir().expect("a temp dir");
    found_vault(dir.path());
    let seat = spawn_seat(dir.path(), "nonce-one");
    let runtime = tokio::runtime::Runtime::new().expect("a runtime");
    let (_shell, token) = runtime.block_on(mint_host_token(&seat.socket, "nonce-one"));

    let mut port = BrowserPort::open(Some(&seat.socket), Some(&token));
    let mut served = Vec::new();
    for method in [
        "status",
        "pair",
        "select-vault",
        "unpair",
        "lock",
        "unlock",
        "warm",
        "modules",
        "blocking-count",
        "locker:candidates",
        "locker:fill",
        "locker:save",
        "capture:task",
        "capture:note",
        "capture:document",
        "agenda:add",
        "people:add",
        "page:capture",
    ] {
        let mut frame = stub_input();
        frame["t"] = serde_json::json!(method);
        let reply = port.ask(&frame);
        let kind = reply["t"].as_str().unwrap_or_default().to_owned();
        let code = reply["code"].as_str().unwrap_or_default().to_owned();
        assert!(kind == "ok" || kind == "error", "{method} answered {reply}");
        assert_ne!(
            code, "unknown-method",
            "{method} is in the table and the host does not know it"
        );
        assert_ne!(
            code, "no-capability",
            "{method} was refused for a capability the host has"
        );
        served.push((method, kind, code));
    }
    assert_eq!(served.len(), 18, "eighteen methods, all answered");
    // AND THE READS ACTUALLY READ. `warm`, `modules` and `blocking-count` reach
    // the vault through the catalogue, so an `ok` from them is a round trip and
    // not a local shortcut.
    let answered = |name: &str| {
        served
            .iter()
            .find(|(method, _, _)| *method == name)
            .map(|(_, kind, code)| (kind.clone(), code.clone()))
            .expect("asked")
    };
    assert_eq!(answered("warm").0, "ok");
    assert_eq!(answered("modules").0, "ok");
    assert_eq!(answered("blocking-count").0, "ok");
    assert_eq!(answered("locker:candidates").0, "ok");
    assert_eq!(answered("status").0, "ok");
    assert_eq!(answered("page:capture").0, "ok");
}

/// THE CLOSED ENUM HAS TEETH: a name that is not one of the eighteen is refused
/// by name, with the sentence that tells a member to update.
#[test]
fn a_nineteenth_method_is_refused_by_name() {
    let dir = tempfile::tempdir().expect("a temp dir");
    found_vault(dir.path());
    let seat = spawn_seat(dir.path(), "nonce-two");
    let runtime = tokio::runtime::Runtime::new().expect("a runtime");
    let (_shell, token) = runtime.block_on(mint_host_token(&seat.socket, "nonce-two"));
    let mut port = BrowserPort::open(Some(&seat.socket), Some(&token));
    for unknown in ["locker:reveal", "vault:sql", "page", "locker:export"] {
        let reply = port.ask(&serde_json::json!({ "t": unknown }));
        assert_eq!(reply["code"], "unknown-method", "{unknown}: {reply}");
        assert_eq!(reply["method"], unknown);
    }
}

/// THE PHISHING RULE, AT THE SOCKET. The browser locks and never unlocks.
#[test]
fn the_browser_may_lock_the_seat_and_may_never_unlock_it() {
    let dir = tempfile::tempdir().expect("a temp dir");
    found_vault(dir.path());
    let seat = spawn_seat(dir.path(), "nonce-three");
    let runtime = tokio::runtime::Runtime::new().expect("a runtime");
    let (_shell, token) = runtime.block_on(mint_host_token(&seat.socket, "nonce-three"));
    let mut port = BrowserPort::open(Some(&seat.socket), Some(&token));

    let locked = port.ask(&serde_json::json!({ "t": "lock" }));
    assert_eq!(locked["t"], "ok", "{locked}");

    let refused = port.ask(&serde_json::json!({ "t": "unlock" }));
    assert_eq!(refused["code"], "not-permitted");
    assert!(
        refused["message"]
            .as_str()
            .expect("a sentence")
            .contains("passphrase"),
        "{refused}"
    );

    // AND THE SEAT REFUSES IT TOO, so the host's refusal is honesty rather than
    // the boundary: a host that sent the message anyway gets `not-permitted`.
    //
    // A SECOND TOKEN, because the first is spent: the seat removes a token from
    // its live map on redemption (D-1020-F14), so the browser port above used
    // the only life the first one had.
    let (_shell2, second) = runtime.block_on(mint_host_token(&seat.socket, "nonce-three"));
    let mut host = runtime.block_on(async {
        let mut stream = UnixStream::connect(&seat.socket).await.expect("connected");
        send(
            &mut stream,
            &serde_json::json!({
                "t": "hello", "client": "native-host",
                "token": second, "protocol": 1
            }),
        )
        .await;
        assert_eq!(recv(&mut stream).await["t"], "hello_ok");
        stream
    });
    runtime.block_on(async {
        send(
            &mut host,
            &serde_json::json!({ "t": "locker_unlock", "id": 1, "passphrase": "whatever-it-is" }),
        )
        .await;
        let refused = recv(&mut host).await;
        assert_eq!(refused["code"], "not-permitted", "{refused}");
    });
}

/// THE FILL FRAME IS WIRED END TO END. There is no login in this vault, so the
/// answer is `locker-missing` — which is the frame having reached the seat's
/// reveal path, been column-checked, and looked for the row. What it is NOT is
/// `unknown-method`, `refused`, or an empty success.
///
/// The value-producing half is proven where the crypto is: the unit tests in
/// `crates/centraid/src/cmd/seat/locker.rs` enrol, unlock and fill a real sealed
/// cell under a real member key and assert the receipt was written first.
#[test]
fn a_fill_reaches_the_seats_own_reveal_path() {
    let dir = tempfile::tempdir().expect("a temp dir");
    found_vault(dir.path());
    let seat = spawn_seat(dir.path(), "nonce-four");
    let runtime = tokio::runtime::Runtime::new().expect("a runtime");
    let (_shell, token) = runtime.block_on(mint_host_token(&seat.socket, "nonce-four"));
    let mut port = BrowserPort::open(Some(&seat.socket), Some(&token));

    let answered = port.ask(&serde_json::json!({
        "t": "locker:fill",
        "itemId": "no-such-item",
        "pageUrl": "https://www.bank.example/sign-in",
    }));
    assert_eq!(answered["code"], "locker-missing", "{answered}");
    assert!(
        !answered.to_string().contains("password"),
        "a refusal must not name a secret: {answered}"
    );

    // A CELL THAT IS NOT FILLABLE IS REFUSED BEFORE ANY ROW IS READ, and the
    // host never lets the column be a parameter anyway — so a frame that names
    // one is answered about `password`.
    let seeded = port.ask(&serde_json::json!({
        "t": "locker:fill",
        "itemId": "no-such-item",
        "pageUrl": "https://www.bank.example/sign-in",
        "column": "otp_seed",
    }));
    assert_eq!(seeded["code"], "locker-missing", "{seeded}");
}

/// CHUNKING, WITH REAL FRAMES. A 3 MB capture is staged in frames that each fit
/// under the browser's 1 MiB ceiling, and the handle addresses the bytes.
#[test]
fn a_three_megabyte_capture_stages_in_frames_that_fit() {
    use base64::Engine as _;

    let dir = tempfile::tempdir().expect("a temp dir");
    found_vault(dir.path());
    let seat = spawn_seat(dir.path(), "nonce-five");
    let runtime = tokio::runtime::Runtime::new().expect("a runtime");
    let (_shell, token) = runtime.block_on(mint_host_token(&seat.socket, "nonce-five"));
    let mut port = BrowserPort::open(Some(&seat.socket), Some(&token));

    let bytes: Vec<u8> = (0..3 * 1024 * 1024).map(|at| (at % 251) as u8).collect();
    let digest = {
        use sha2::Digest as _;
        let mut hasher = sha2::Sha256::new();
        hasher.update(&bytes);
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    let begun = port.ask(&serde_json::json!({
        "t": "stage:begin",
        "media_type": "image/png",
        "byte_size": bytes.len(),
        "sha256": digest,
    }));
    assert_eq!(begun["t"], "ok", "{begun}");
    let staging_id = begun["value"]["staging_id"]
        .as_str()
        .expect("a staging id")
        .to_owned();
    let chunk_bytes = begun["value"]["chunk_bytes"]
        .as_u64()
        .expect("a chunk size") as usize;

    let mut frames = 0_usize;
    for (seq, window) in bytes.chunks(chunk_bytes).enumerate() {
        let frame = serde_json::json!({
            "t": "stage:chunk",
            "staging_id": staging_id,
            "seq": seq,
            "bytes_b64": base64::engine::general_purpose::STANDARD.encode(window),
        });
        // EVERY FRAME FITS. The assertion is on the encoded frame, not on the
        // payload, because the browser's ceiling is on the message.
        let encoded = serde_json::to_vec(&frame).expect("encoded");
        assert!(
            encoded.len() < 1024 * 1024,
            "chunk {seq} is {} bytes, over the browser's ceiling",
            encoded.len()
        );
        let chunked = port.ask(&frame);
        assert_eq!(chunked["t"], "ok", "chunk {seq}: {chunked}");
        frames += 1;
    }
    assert_eq!(frames, 6, "six chunks at 512 KiB each");

    let handle = port.ask(&serde_json::json!({
        "t": "stage:end",
        "staging_id": staging_id,
    }));
    assert_eq!(handle["t"], "ok", "{handle}");
    assert_eq!(handle["value"]["sha256"], digest);
    assert_eq!(handle["value"]["byte_size"], bytes.len());
    // HONEST ABOUT WHERE THE BYTES STOP (D-1020-X3).
    assert_eq!(handle["value"]["claimed"], false);
    assert_eq!(handle["value"]["pending"], "bytes-door");

    // A REPLAYED CLOSE GETS NOTHING.
    let replay = port.ask(&serde_json::json!({
        "t": "stage:end",
        "staging_id": staging_id,
    }));
    assert_eq!(replay["t"], "error", "{replay}");
}

/// NO CAPABILITY, NO RELAY — and the member reads a sentence rather than a code.
///
/// `ping` still answers, because the extension's first screen needs to know
/// whether the app is installed at all, and it reports `attached: false` rather
/// than pretending.
#[test]
fn the_host_without_a_token_answers_a_member_sentence() {
    let mut port = BrowserPort::open(None, None);
    let pong = port.ask(&serde_json::json!({ "t": "ping" }));
    assert_eq!(pong["t"], "pong");
    assert_eq!(pong["attached"], false);
    let refused = port.ask(&serde_json::json!({ "t": "status" }));
    assert_eq!(refused["code"], "no-capability");
    assert_eq!(
        refused["message"],
        "Open Centraid and allow the browser extension to connect."
    );
}
