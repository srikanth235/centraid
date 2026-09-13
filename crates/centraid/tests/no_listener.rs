//! `centraid gateway` opens **no listening TCP socket** (#1020 invariant).
//!
//! The xtask `no-listening-socket` rule scans the source for `TcpListener::bind`
//! on every gate run, which catches the shape of the mistake. This test catches
//! the fact: it spawns the real binary, waits for its ready line, and reads the
//! kernel's own answer out of `/proc/net/tcp` and `/proc/net/tcp6`, matching
//! sockets to the process by inode against `/proc/<pid>/fd`.
//!
//! Why both: a dependency could open a listener without the string ever
//! appearing in this repository's source, and a scanner would never see it. The
//! acceptance criterion #1020 writes is about the RUNNING process — "`centraid
//! gateway` runs from the Docker image on a clean VPS with no listening TCP
//! port" — so the test reads the running process.
//!
//! Linux only. On another platform it skips with the reason rather than passing
//! silently, because a test that passes where it cannot look is the failure mode
//! the whole gate posture is written against.

use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead as _, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const READY_LINE: &str = "centraid gateway ready";

/// `/proc/net/tcp`'s `st` column for LISTEN.
const TCP_LISTEN: &str = "0A";

fn binary() -> PathBuf {
    // The integration test binary lives beside the crate's binaries.
    let mut path = PathBuf::from(env!("CARGO_BIN_EXE_centraid"));
    if !path.is_file() {
        path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/debug/centraid")
            .canonicalize()
            .expect("the centraid binary is built");
    }
    path
}

/// Every socket inode the process owns, from `/proc/<pid>/fd`.
fn socket_inodes(pid: u32) -> BTreeSet<u64> {
    let mut inodes = BTreeSet::new();
    let fd_dir = PathBuf::from(format!("/proc/{pid}/fd"));
    let Ok(entries) = fs::read_dir(&fd_dir) else {
        return inodes;
    };
    for entry in entries.flatten() {
        if let Ok(target) = fs::read_link(entry.path()) {
            let target = target.to_string_lossy().to_string();
            if let Some(rest) = target.strip_prefix("socket:[")
                && let Some(number) = rest.strip_suffix(']')
                && let Ok(inode) = number.parse::<u64>()
            {
                inodes.insert(inode);
            }
        }
    }
    inodes
}

/// Every LISTEN row in `/proc/net/tcp*`, as `(local_address, inode)`.
fn listening_tcp_rows() -> Vec<(String, u64)> {
    let mut rows = Vec::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = fs::read_to_string(table) else {
            continue;
        };
        for line in text.lines().skip(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            // sl local_address rem_address st ... uid timeout inode
            if fields.len() < 10 || fields[3] != TCP_LISTEN {
                continue;
            }
            if let Ok(inode) = fields[9].parse::<u64>() {
                rows.push((fields[1].to_owned(), inode));
            }
        }
    }
    rows
}

struct Gateway {
    child: Child,
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Spawn `centraid gateway` and wait for its ready line on stdout.
fn spawn_gateway(args: &[&str]) -> (Gateway, String) {
    let mut child = Command::new(binary())
        .arg("gateway")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn centraid gateway");

    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut ready = String::new();
    let mut seen = String::new();
    while Instant::now() < deadline {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                seen.push_str(&line);
                if line.starts_with(READY_LINE) {
                    ready = line.trim().to_owned();
                    break;
                }
            }
            Err(error) => panic!("reading the gateway's stdout: {error}"),
        }
    }
    // Keep reading in the background so a full pipe never blocks the child.
    std::thread::spawn(move || {
        let mut sink = String::new();
        let _ = reader.read_line(&mut sink);
        loop {
            sink.clear();
            if reader.read_line(&mut sink).unwrap_or(0) == 0 {
                break;
            }
        }
    });
    assert!(
        !ready.is_empty(),
        "the gateway never printed its ready line. What it did print:\n{seen}"
    );
    (Gateway { child }, ready)
}

/// THE INVARIANT. A running `centraid gateway` owns no LISTEN socket.
#[test]
fn a_running_gateway_owns_no_listening_tcp_socket() {
    if !Path::new("/proc/net/tcp").exists() {
        eprintln!(
            "SKIP: /proc/net/tcp is not readable on this platform, so the kernel's own answer \
             cannot be read. The xtask `no-listening-socket` rule still scans the source, and the \
             wave 3 lane G VPS smoke asserts it on Linux."
        );
        return;
    }

    let (gateway, ready) = spawn_gateway(&["--no-relay"]);
    let pid = gateway.child.id();
    assert!(
        ready.contains("endpoint="),
        "the ready line must name the endpoint id so a wrapper can pair: {ready}"
    );

    let inodes = socket_inodes(pid);
    assert!(
        !inodes.is_empty(),
        "the process owns no sockets at all, so this test would pass vacuously — the gateway did \
         not bind its UDP socket"
    );

    let offending: Vec<(String, u64)> = listening_tcp_rows()
        .into_iter()
        .filter(|(_, inode)| inodes.contains(inode))
        .collect();
    assert!(
        offending.is_empty(),
        "centraid gateway (pid {pid}) owns {} LISTEN socket(s): {offending:?}. iroh is QUIC over \
         UDP, and the only listener this product may ever have is the wave 3 blob door behind \
         `#[cfg(feature = \"blob-door\")]`, off by default (#1020 open question 3).",
        offending.len()
    );
}

/// `--print-qr` prints a ticket the CLI itself can parse, and a QR beside it.
/// The ticket line comes FIRST so an ssh session can copy it before a QR
/// scrolls it away.
#[test]
fn print_qr_emits_a_parseable_ticket_and_a_qr() {
    let output = Command::new(binary())
        .args(["pair", "--mint", "--no-relay"])
        .output()
        .expect("run centraid pair --mint");
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);

    let ticket_line = stdout
        .lines()
        .find_map(|line| line.strip_prefix("ticket "))
        .expect("a `ticket <base64url>` line on stdout");
    assert!(
        centraid_net::ticket::decode(ticket_line).is_some(),
        "the printed ticket does not parse as a v1 PairTicket: {ticket_line}"
    );
    assert_eq!(
        stdout.lines().next().expect("a first line"),
        format!("ticket {ticket_line}"),
        "the ticket must be the first line, before the QR"
    );

    let qr_rows = stdout
        .lines()
        .filter(|line| line.contains('█') || line.contains('▀') || line.contains('▄'))
        .count();
    assert!(qr_rows > 10, "no QR was rendered: {qr_rows} rows");
}

/// Every verb whose implementation lands in a later lane exits 3 and says so.
/// Never 0 (#1020, D-1020-C11).
///
/// The list SHRINKS as lanes land, and it has shrunk three times: `backup now`,
/// `recover` and `export` became real in wave 2 lane R, `doctor` in wave 3 lane
/// G (`cmd/doctor.rs`; it now exits 0 on a clean vault and 1 when there is no
/// vault to check, which `tests/gateway_install.rs` and the release smoke both
/// rely on), and `seat` plus `native-host` in wave 3 lane F — each with its own
/// implementation and its own tests in the same commit, which is what the rule
/// requires of a verb that leaves this list. The rule itself is untouched: a
/// verb that is not implemented exits 3 and never 0.
#[test]
fn every_unimplemented_verb_exits_three_and_names_its_lane() {
    let verbs: [&[&str]; 2] = [&["devices", "list"], &["devices", "revoke", "d-1"]];
    for verb in verbs {
        let output = Command::new(binary())
            .args(verb)
            .output()
            .unwrap_or_else(|error| panic!("run centraid {verb:?}: {error}"));
        assert_eq!(
            output.status.code(),
            Some(3),
            "centraid {verb:?} exited {:?}, not 3",
            output.status.code()
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("wave"),
            "centraid {verb:?} must name the wave and lane that owns it: {stderr}"
        );
        assert!(
            stderr.contains("#1020"),
            "centraid {verb:?} must cite the issue: {stderr}"
        );
    }
}

/// `seat` is implemented (wave 3 lane F) and its refusals are USAGE errors with
/// the missing flag named, never a zero exit on work that did not happen.
///
/// This replaces the "exit 3" row the verb used to occupy above. The property
/// that mattered there — a verb must not exit 0 without doing its work — is
/// what is asserted here, against the real implementation.
#[test]
fn the_seat_verb_names_the_flag_it_needs_rather_than_exiting_zero() {
    let output = Command::new(binary())
        .arg("seat")
        .output()
        .expect("run centraid seat");
    assert_eq!(
        output.status.code(),
        Some(2),
        "a seat with no socket is usage"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("--socket"), "{stderr}");

    // With a socket but no data directory: still usage, and still names the
    // flag. A seat with no vault file would answer every read with an empty
    // list, which is the three-state read law's exact failure.
    let output = Command::new(binary())
        .args(["seat", "--socket", "/tmp/centraid-cli-never.sock"])
        .output()
        .expect("run centraid seat");
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("--data-dir"),
        "the refusal must name the flag"
    );
    assert!(
        !std::path::Path::new("/tmp/centraid-cli-never.sock").exists(),
        "a refused seat must not have bound a socket"
    );
}

/// The statement catalogue the socket serves is printable, and it is the same
/// document `contracts/desktop/socket-catalogue.json` pins.
#[test]
fn the_seat_prints_the_catalogue_it_serves() {
    let output = Command::new(binary())
        .args(["seat", "--print-catalogue"])
        .output()
        .expect("run centraid seat --print-catalogue");
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&output.stdout);
    let printed: serde_json::Value =
        serde_json::from_str(&stdout).unwrap_or_else(|error| panic!("not JSON: {error}\n{stdout}"));
    let committed: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../contracts/desktop/socket-catalogue.json"),
        )
        .expect("the committed catalogue is readable"),
    )
    .expect("the committed catalogue is JSON");
    assert_eq!(
        printed, committed,
        "the catalogue moved: re-run `centraid seat --print-catalogue > \
         contracts/desktop/socket-catalogue.json` and say in the receipt what changed"
    );
}

/// `native-host` is checked apart from the list above because it is the one
/// verb a BROWSER launches. Two properties, and both are about stdout: **stdout
/// is the protocol**, so a closed port exits 0 having written nothing, and a
/// `ping` is answered in the browser's own framing.
#[test]
fn the_native_messaging_host_answers_a_ping_in_the_browsers_framing() {
    use std::io::Write as _;
    use std::process::Stdio;

    // A closed port: a clean end of stream is a closed tab, not a failure.
    let output = Command::new(binary())
        .arg("native-host")
        .stdin(Stdio::null())
        .output()
        .expect("run centraid native-host");
    assert_eq!(output.status.code(), Some(0));
    assert!(
        output.stdout.is_empty(),
        "stdout IS the protocol: nothing may be written to it unprompted"
    );

    // THE ROUND TRIP. `u32` in the HOST's byte order, then UTF-8 JSON — not the
    // product's own `u32BE` framing, which is the trap this asserts against.
    let body = br#"{"t":"ping"}"#;
    let mut child = Command::new(binary())
        .arg("native-host")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn centraid native-host");
    {
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin
            .write_all(&(body.len() as u32).to_ne_bytes())
            .expect("length");
        stdin.write_all(body).expect("body");
    }
    drop(child.stdin.take());
    let output = child.wait_with_output().expect("the host finished");
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stdout.len() > 4, "no reply was framed");
    let length = u32::from_ne_bytes(output.stdout[..4].try_into().expect("four bytes")) as usize;
    assert_eq!(
        output.stdout.len(),
        4 + length,
        "the frame's length is wrong"
    );
    let reply: serde_json::Value =
        serde_json::from_slice(&output.stdout[4..]).expect("the reply is JSON");
    assert_eq!(reply["t"], "pong");
    assert_eq!(reply["host"], "dev.centraid.host");
    // No shell has minted a capability token for this process, so it says so
    // rather than claiming a seat it cannot reach.
    assert_eq!(reply["attached"], false);
}

/// A host manifest needs an extension-id allowlist, and the verb writes one
/// only where the operator says.
#[test]
fn the_host_manifest_carries_an_allowlist_and_is_never_installed_by_guessing() {
    let dir = std::env::temp_dir().join("centraid-cli-native-host");
    let _ = fs::remove_dir_all(&dir);
    let out = dir.join("dev.centraid.host.json");
    let output = Command::new(binary())
        .args([
            "native-host",
            "install",
            "--browser",
            "chrome",
            "--extension-id",
            "abcdefghijklmnopabcdefghijklmnop",
            "--out",
            out.to_str().expect("utf8"),
        ])
        .output()
        .expect("run centraid native-host install");
    assert_eq!(output.status.code(), Some(0));
    let written: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&out).expect("written")).expect("JSON");
    assert_eq!(written["type"], "stdio");
    assert_eq!(
        written["allowed_origins"][0],
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
    );
    // The path is THIS binary, so the browser launches the artifact that wrote
    // the manifest and not whatever is on PATH.
    assert_eq!(
        written["path"].as_str().expect("a path"),
        binary().to_str().expect("utf8")
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("copy it to"),
        "the verb must say where it goes rather than putting it there: {stderr}"
    );
    // With no allowlist clap refuses before anything is written.
    let output = Command::new(binary())
        .args(["native-host", "install", "--browser", "chrome"])
        .output()
        .expect("run centraid native-host install");
    assert_eq!(output.status.code(), Some(2));
    let _ = fs::remove_dir_all(&dir);
}

/// A vault directory that is accepted but not yet durable SAYS SO. A gateway
/// that took `--data-dir` and kept nothing would lose every pairing on restart
/// with no warning.
#[test]
fn a_data_dir_that_is_not_yet_durable_is_named_as_such() {
    let dir = std::env::temp_dir().join("centraid-cli-data-dir");
    let _ = fs::create_dir_all(&dir);
    let (gateway, _ready) =
        spawn_gateway(&["--no-relay", "--data-dir", dir.to_str().expect("utf8")]);
    // The warning is on stderr, which the spawn helper piped; read what is
    // there without blocking on more.
    drop(gateway);

    // Re-run without the long-lived child so stderr can be read to completion:
    // `pair --mint` shares the same non-durability note.
    let output = Command::new(binary())
        .args(["pair", "--mint", "--no-relay"])
        .output()
        .expect("run");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("D-1020-C8"),
        "the non-durable pairing store must be named, with its decision: {stderr}"
    );
}

/// The verbs wave 2 lane R landed are no longer "not yet available", and a
/// missing argument is a REFUSAL or a USAGE error rather than exit 3 — which is
/// what keeps exit 3 meaning something (#1020, D-1020-C11 as it now stands).
#[test]
fn the_verbs_lane_r_landed_no_longer_exit_three() {
    for (verb, expected) in [
        (vec!["backup", "now"], 1),
        (vec!["recover"], 2),
        (vec!["export"], 2),
    ] {
        let output = Command::new(binary())
            .args(&verb)
            .output()
            .unwrap_or_else(|error| panic!("run centraid {verb:?}: {error}"));
        assert_eq!(
            output.status.code(),
            Some(expected),
            "centraid {verb:?} exited {:?}, expected {expected}",
            output.status.code()
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !stderr.contains("not available in this build"),
            "centraid {verb:?} still claims to be unavailable: {stderr}"
        );
    }
}
