//! THE IDENTITY A GATEWAY ENROLLED, KEPT AND CHECKED (#1025 S7-13).
//!
//! ## The defect this exists for
//!
//! A seat paired, closed, reopened, dialled its own gateway — and was refused
//! as an unenrolled peer. The gateway was right: the endpoint that dialled had
//! a public key it had never seen, because the secret half had not reached
//! `attach_network` and the endpoint had minted a fresh one. Nothing on the
//! seat could tell that from a version disagreement, so the phone rendered
//! "this app and that gateway are too far apart in version to talk" and sent a
//! member to update an app that was working correctly.
//!
//! **No shell is involved here.** #1025 S7-9 reproduced this on the simulator
//! and could not place it, and the reason is that the shell, the FFI, the core,
//! the link and the gateway were all candidates. This test holds every one of
//! them except the shell: a real `centraid gateway` over real QUIC, driven
//! through `centraid_open`/`centraid_call` with the same JSON a phone sends.
//!
//! Two cases, and the second is the one that was missing:
//!
//! 1. **Pair, close, reopen with the same record, dial again — and it works.**
//!    That is the S5 property, held through a close this time.
//! 2. **Reopen with a DIFFERENT secret — and the open is refused**, with
//!    `IdentityMismatch`, before any dial. A device whose credential is gone
//!    says so in its own words rather than earning a refusal from a peer that
//!    describes something else.

use std::io::{BufRead as _, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core_ffi::{
    CENTRAID_OK, centraid_call, centraid_close, centraid_free, centraid_open,
};
use prost::Message as _;

const READY_LINE: &str = "centraid gateway ready";

/// See `walking_skeleton.rs`: a freshly bound endpoint's first dial races its
/// own address discovery, and this is the host's networking rather than this
/// product's. Nothing is asserted about the duration.
///
/// **Six and not three, and the difference is measured rather than guessed.**
/// This test opens the endpoint THREE times against one gateway; at three
/// seconds the first pairing dial ran past the ten-second connect bound on this
/// host, every run. It is a property of address discovery on the machine, not
/// of the product, which is why it is a sleep with no assertion on it.
const ENDPOINT_WARMUP: Duration = Duration::from_secs(6);

struct Gateway(Child);

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Seed FIRST, start SECOND. A gateway does not notice commits another process
/// makes to its file, so a vault seeded under a running gateway is a vault the
/// gateway is not serving.
fn seed(data_dir: &std::path::Path) {
    let vault_dir = data_dir.join("vault").join("v1");
    std::fs::create_dir_all(&vault_dir).expect("the layout is made");
    let status = Command::new(env!("CARGO_BIN_EXE_seed-demo-vault"))
        .arg(&vault_dir)
        .arg("--file")
        .arg("vault.db")
        .arg("--name")
        .arg("Identity")
        .arg("--only")
        .arg("notes")
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .status()
        .expect("the seeder runs");
    assert!(status.success(), "the seeder refused: {status:?}");
}

fn start_gateway(data_dir: &std::path::Path) -> Option<(Gateway, String)> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_centraid"))
        .arg("gateway")
        .arg("--data-dir")
        .arg(data_dir)
        .arg("--print-qr")
        .arg("--no-relay")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("the gateway binary runs");
    let stdout = child.stdout.take().expect("piped");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut ready = false;
        let mut sent = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.starts_with(READY_LINE) {
                ready = true;
            }
            if let Some(encoded) = line.strip_prefix("ticket ")
                && ready
                && !sent
            {
                sent = true;
                let _ = tx.send(encoded.trim().to_owned());
            }
        }
    });
    match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(encoded) => Some((Gateway(child), encoded)),
        Err(_) => None,
    }
}

/// THE ENROLMENT RECORD, EXACTLY AS A SHELL SENDS IT.
///
/// One entry per vault carrying the secret, the address, the relay statement
/// and the key the gateway said it enrolled. `relayUrl: ""` is a STATEMENT that
/// this deployment has no relay — the gateway above is `--no-relay` — where an
/// absent key would mean "not told yet" and leave relays on.
fn config(path: &std::path::Path, secret_hex: &str, enrolled_hex: &str) -> String {
    serde_json::json!({
        "path": path.display().to_string(),
        "role": "seat-replicated",
        "pairing": {
            "secret": secret_hex,
            "relayUrl": "",
            "enrolledPublicKey": enrolled_hex,
        },
    })
    .to_string()
}

/// Open a seat, answering the ABI's status code so a refusal can be read.
fn open(config: &str) -> Result<*mut centraid_core::Handle, i32> {
    let mut handle: *mut centraid_core::Handle = std::ptr::null_mut();
    // SAFETY: `config` outlives the call and `handle` is a live local.
    let code = unsafe { centraid_open(config.as_ptr(), config.len(), &raw mut handle) };
    if code == CENTRAID_OK && !handle.is_null() {
        Ok(handle)
    } else {
        Err(code)
    }
}

/// One request, as bytes, answered as an `Envelope`.
fn call(handle: *mut centraid_core::Handle, kind: wire::request::Kind) -> wire::Envelope {
    let request = wire::Envelope {
        request_id: 1,
        body: Some(wire::envelope::Body::Request(wire::Request {
            kind: Some(kind),
        })),
    }
    .encode_to_vec();
    let mut buf: *mut u8 = std::ptr::null_mut();
    let mut len: usize = 0;
    // SAFETY: the handle is live, the request outlives the call and both
    // out-pointers are live locals.
    let code = unsafe {
        centraid_call(
            handle,
            request.as_ptr(),
            request.len(),
            &raw mut buf,
            &raw mut len,
        )
    };
    assert!(!buf.is_null(), "the ABI answered nothing (code {code})");
    // SAFETY: `buf`/`len` are what the call reported.
    let bytes = unsafe { std::slice::from_raw_parts(buf, len) }.to_vec();
    // SAFETY: freed exactly once, with the length the call handed back.
    unsafe { centraid_free(buf, len) };
    wire::Envelope::decode(bytes.as_slice()).expect("the answer is an Envelope")
}

fn sync_now(handle: *mut centraid_core::Handle) -> wire::CommandOutcome {
    match call(
        handle,
        wire::request::Kind::Command(wire::Command {
            name: centraid_core::handle::SEAT_SYNC_COMMAND.to_owned(),
            invoke_key: "test".to_owned(),
            ..Default::default()
        }),
    )
    .body
    {
        Some(wire::envelope::Body::Response(response)) => match response.kind {
            Some(wire::response::Kind::Command(outcome)) => outcome,
            other => panic!("expected a CommandOutcome, got {other:?}"),
        },
        Some(wire::envelope::Body::Error(error)) => {
            panic!("the core refused the pass: code={} {}", error.code, error.detail)
        }
        other => panic!("expected a Response, got {other:?}"),
    }
}

/// `{"unreachable": bool, …}` — the pass's own report, as canonical JSON.
fn unreachable(outcome: &wire::CommandOutcome) -> bool {
    serde_json::from_slice::<serde_json::Value>(&outcome.output)
        .ok()
        .and_then(|value| value.get("unreachable").and_then(serde_json::Value::as_bool))
        .unwrap_or(true)
}

#[test]
fn a_seat_reopened_on_its_own_record_is_the_device_its_gateway_enrolled() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_test_writer()
        .try_init();
    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");
    seed(gateway_dir.path());
    let Some((_gateway, ticket)) = start_gateway(gateway_dir.path()) else {
        panic!("the gateway printed no ticket within 30s");
    };

    // ---- 1. PAIR, on the identity the shell minted ------------------------
    let replica = seat_dir.path().join("centraid-seat.sqlite3");
    let secret = "3d".repeat(32);
    let handle = open(&config(&replica, &secret, "")).expect("the seat core opens");
    std::thread::sleep(ENDPOINT_WARMUP);
    let paired = match call(
        handle,
        wire::request::Kind::Pair(wire::PairRequest {
            code: ticket.into_bytes(),
            device_name: "Identity Seat".to_owned(),
            platform: "ios".to_owned(),
            ..Default::default()
        }),
    )
    .body
    {
        Some(wire::envelope::Body::Response(response)) => match response.kind {
            Some(wire::response::Kind::Pair(pair)) => match pair.result.expect("a result") {
                wire::pair_response::Result::Ok(ok) => ok,
                wire::pair_response::Result::Error(error) => {
                    panic!("the gateway refused the ticket: {error:?}")
                }
            },
            other => panic!("expected a PairResponse, got {other:?}"),
        },
        other => panic!("expected a Response, got {other:?}"),
    };

    // THE GATEWAY SAYS WHICH KEY IT ENROLLED, and it is the one iroh's TLS
    // proved on the connection — never a field this device asserted. Without
    // this the seat has nothing to check its own endpoint against.
    let enrolled = hex(&paired.enrolled_public_key);
    assert_eq!(
        enrolled.len(),
        64,
        "the pairing answered no enrolled key; every later open is then unchecked"
    );

    // ---- 2. CLOSE, AND REOPEN ON THE SAME RECORD --------------------------
    // SAFETY: a live handle from `open`, closed once and never used again.
    unsafe { centraid_close(handle) };

    let reopened =
        open(&config(&replica, &secret, &enrolled)).expect("the seat reopens on its own record");
    std::thread::sleep(ENDPOINT_WARMUP);
    let outcome = sync_now(reopened);
    assert!(
        !unreachable(&outcome),
        "a reopened seat was refused by its own gateway: {}",
        String::from_utf8_lossy(&outcome.output)
    );
    // SAFETY: as above.
    unsafe { centraid_close(reopened) };

    // ---- 3. A DIFFERENT SECRET IS REFUSED AT THE DOOR ---------------------
    //
    // This is the case the product hits when the secure store loses the key, or
    // never kept it: the endpoint comes up as somebody the gateway has never
    // enrolled. The open fails, no dial is made, and the refusal names the
    // credential rather than the peer.
    let stranger = open(&config(&replica, &"11".repeat(32), &enrolled));
    match stranger {
        Ok(handle) => {
            // SAFETY: a live handle; closed so the failure does not leak one.
            unsafe { centraid_close(handle) };
            panic!("a seat opened with an identity its gateway has never enrolled");
        }
        // A NEGATIVE CODE AND NO HANDLE. `centraid_open` has no response bytes
        // to put an `ErrorCode` in, so what a shell gets here is the status and
        // a log line naming both keys — and what it must never get is `OK` with
        // nothing written to `out`.
        Err(code) => assert_eq!(code, centraid_core_ffi::CENTRAID_BAD_ARGUMENT),
    }
}

/// 32 raw bytes as 64 lowercase hex.
fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut text, byte| {
        use std::fmt::Write as _;
        let _ = write!(text, "{byte:02x}");
        text
    })
}

/// THE ENROLMENT OUTLIVES THE GATEWAY PROCESS (#1025 S7, **D-1025-S7-8x**).
///
/// ## The defect this exists for
///
/// `centraid gateway` kept its allowlist in `MemoryAllowlist` and printed a
/// line saying every pairing was lost on exit. A member paired a phone,
/// restarted the gateway for any ordinary reason — an update, a reboot — and
/// the phone was refused as a peer that had never been enrolled. The phone
/// could not tell that from a revocation, because unknown and revoked are one
/// refusal, which is right for a stranger and wrong for a device enrolled the
/// day before.
///
/// **There were TWO causes and this test holds both.** Enrolment was not
/// durable, and neither was the gateway's own endpoint identity: `centraid
/// gateway` built its endpoint from `EndpointConfig::default()`, which mints a
/// fresh secret key, so the address in every pairing record stopped resolving
/// at the same moment. Either one alone makes a paired seat fail, and a test
/// that fixed only the allowlist would have gone green on a gateway no seat
/// could reach.
///
/// Three processes over ONE data directory, and the third is the one that keeps
/// this honest: a persisted allowlist that persisted a revocation too is the
/// difference between "it remembers" and "it admits everyone".
#[test]
fn a_gateway_restart_keeps_the_devices_it_enrolled_and_the_one_it_revoked() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_test_writer()
        .try_init();
    let gateway_dir = tempfile::tempdir().expect("a temp dir");
    let seat_dir = tempfile::tempdir().expect("a temp dir");
    seed(gateway_dir.path());

    // ---- 1. PAIR, against the gateway's FIRST process ---------------------
    let first = start_gateway(gateway_dir.path());
    let Some((first, ticket)) = first else {
        panic!("the gateway printed no ticket within 30s");
    };
    let replica = seat_dir.path().join("centraid-seat.sqlite3");
    let secret = "7c".repeat(32);
    let handle = open(&config(&replica, &secret, "")).expect("the seat core opens");
    std::thread::sleep(ENDPOINT_WARMUP);
    let paired = match call(
        handle,
        wire::request::Kind::Pair(wire::PairRequest {
            code: ticket.into_bytes(),
            device_name: "Restart Seat".to_owned(),
            platform: "ios".to_owned(),
            ..Default::default()
        }),
    )
    .body
    {
        Some(wire::envelope::Body::Response(response)) => match response.kind {
            Some(wire::response::Kind::Pair(pair)) => match pair.result.expect("a result") {
                wire::pair_response::Result::Ok(ok) => ok,
                wire::pair_response::Result::Error(error) => {
                    panic!("the gateway refused the ticket: {error:?}")
                }
            },
            other => panic!("expected a PairResponse, got {other:?}"),
        },
        other => panic!("expected a Response, got {other:?}"),
    };
    let enrolled = hex(&paired.enrolled_public_key);
    assert_eq!(enrolled.len(), 64, "the pairing answered no enrolled key");
    // SAFETY: a live handle from `open`, closed once and never used again.
    unsafe { centraid_close(handle) };
    drop(first);

    // ---- 2. A SECOND PROCESS, SAME DIRECTORY, SAME SEAT --------------------
    let Some((second, _)) = start_gateway(gateway_dir.path()) else {
        panic!("the restarted gateway printed no ticket within 30s");
    };
    let reopened = open(&config(&replica, &secret, &enrolled)).expect("the seat reopens");
    std::thread::sleep(ENDPOINT_WARMUP);
    let outcome = sync_now(reopened);
    assert!(
        !unreachable(&outcome),
        "a gateway forgot a pairing across a restart: {}",
        String::from_utf8_lossy(&outcome.output)
    );
    // SAFETY: as above.
    unsafe { centraid_close(reopened) };
    drop(second);

    // ---- 3. REVOKE, AND THE REFUSAL SURVIVES THE NEXT RESTART -------------
    //
    // Through the vault, because the vault's `access_device` rows ARE the
    // allowlist now: revoking is the same act whether a member does it from
    // their device list or a script does it here, and that is the property
    // worth asserting. `dev_` + the first eight bytes of the proved key is
    // `centraid_net::pairing`'s own spelling of the device id.
    let device_id = format!("dev_{}", &enrolled[..16]);
    {
        let file = gateway_dir.path().join("vault").join("v1").join("vault.db");
        let core = centraid_core::Core::open(centraid_core::CoreConfig {
            pairing: None,
            path: file,
            role: centraid_core::Role::Gateway,
            ui_thread_name: None,
            create: false,
            clock: None,
            ids: None,
            expected_digest: None,
        })
        .expect("the gateway's vault opens");
        let revoked = core
            .with_vault(|vault| Ok(vault.revoke_device(&device_id)?))
            .expect("the revocation runs");
        assert!(revoked, "the enrolment never reached the vault at all");
        core.close();
    }

    let Some((third, _)) = start_gateway(gateway_dir.path()) else {
        panic!("the third gateway printed no ticket within 30s");
    };
    let refused = open(&config(&replica, &secret, &enrolled)).expect("the seat reopens");
    std::thread::sleep(ENDPOINT_WARMUP);
    let outcome = sync_now(refused);
    assert!(
        unreachable(&outcome),
        "a revoked device was admitted after a restart: {}",
        String::from_utf8_lossy(&outcome.output)
    );
    // SAFETY: as above.
    unsafe { centraid_close(refused) };
    drop(third);
}
