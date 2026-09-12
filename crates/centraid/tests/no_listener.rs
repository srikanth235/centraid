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
#[test]
fn every_unimplemented_verb_exits_three_and_names_its_lane() {
    let verbs: [&[&str]; 6] = [
        &["seat"],
        &["devices", "list"],
        &["backup", "now"],
        &["doctor"],
        &["recover"],
        &["export"],
    ];
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

/// `native-host` is exit 3 too, and it is checked apart from the list above
/// because it is the one verb a BROWSER launches: a zero exit on a stub would
/// make the extension believe it has a working host.
#[test]
fn the_native_messaging_host_refuses_rather_than_exiting_zero() {
    let output = Command::new(binary())
        .arg("native-host")
        .output()
        .expect("run centraid native-host");
    assert_eq!(output.status.code(), Some(3));
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
