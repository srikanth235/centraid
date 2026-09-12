//! `vps-smoke` — THE RELEASE SMOKE, against a clean container (#1020, D-1020-G5).
//!
//! #1020's wave 3 exit is *release smoke on a clean VPS*. A real VPS is an
//! owner hand-off (the commands and the expected transcript are in
//! `docs/release.md`); what is provable on this machine is the device-less half
//! of the same thing, and it is provable for real rather than as a stub: a
//! **clean Docker container** that has never seen Centraid, the published
//! tarball, and the installer an operator would actually run.
//!
//! ## What it proves, in order
//!
//! 1. `deploy/vps/install.sh` verifies the tarball against `SHA256SUMS`,
//!    refuses to unpack an unverified one, and checks the installed binary's
//!    identity stamp against the release's `identity.json`.
//! 2. `centraid gateway install --system --dry-run` prints a unit and **writes
//!    nothing** — checked by listing `/etc/systemd/system` before and after,
//!    not by trusting the message. Census §G seam G11: a smoke that installed
//!    services would be mutating the host it is measuring.
//! 3. The gateway **founds a vault** in an empty data directory and prints its
//!    ready line.
//! 4. A seat **pairs over iroh** — in-container, direct path, no relay.
//! 5. The **WAL capture tick** is alive — `<data-dir>/wal/tick.json`, rewritten
//!    every tick — and `centraid backup now` takes a generation and reports the
//!    tail count it shipped. The count is PRINTED and not required to be
//!    non-zero, and the container script says why in full: nothing writes to
//!    the vault after it is founded until the durable allowlist lands
//!    (D-1020-C8), so a tick that sealed nothing is correct. The capture
//!    mechanics are proved by unit tests over a WAL that does grow.
//! 6. `centraid doctor` is clean.
//! 7. The container is **restarted** over the same data directory: the gateway
//!    opens the existing vault rather than founding a second one, a seat pairs
//!    again, and `doctor` is still clean.
//! 8. The **negative**: the same install with a tampered `identity.json` is
//!    REFUSED, with the mismatch named. A verification that has never been seen
//!    to fail is not a verification.
//!
//! ## What it does NOT prove, and says so
//!
//! **It smokes the `release` binary, not the `dist` one.** A tag publishes
//! `--profile dist` (`release` plus thin LTO), and `release` is what a pull
//! request builds — the two profiles were split because thin LTO put the
//! workspace release build at 1039 s against a 600 s ceiling (root
//! `Cargo.toml`). What differs between them is inlining; the panic strategy,
//! the debuginfo shape and the dependency graph are identical. The `dist`
//! artifact's own proof is `.github/workflows/lane-prebuilt-core.yml`, which
//! builds it, stamps it, reads the stamp back OUT of the binary, and publishes
//! it with its symbol file.
//!
//! The device allowlist is still in memory (D-1020-C8; `crates/vault`'s durable
//! `AllowlistStore` is wave 2 lane D2's). So phase 7 proves *a seat pairs again
//! after a restart*, not *the seat that paired before the restart reconnects
//! without pairing*. The difference is stated in the transcript rather than
//! blurred: the second is what the durable allowlist is for, and claiming it
//! here would be the smoke reporting a property nothing has.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use anyhow::{Context, Result, bail};

/// The base image. Digest-pinned for the same reason `deploy/docker`'s are: a
/// smoke whose base image moved under it reports a different answer on two runs
/// of the same commit.
const BASE_IMAGE: &str =
    "debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132";

/// The host triple this machine publishes. The artifact NAME is the triple, so
/// the smoke has to name it too.
const TRIPLE: &str = "x86_64-unknown-linux-gnu";

pub struct Outcome {
    pub ok: bool,
    pub line: String,
    /// The transcript, written beside the artifacts. The step's line names it;
    /// this field carries the path so a caller that wants to attach it to a
    /// report does not have to re-derive it.
    #[allow(
        dead_code,
        reason = "the release workflow uploads target/xtask/**; a caller inside this crate reads the line, not the path"
    )]
    pub transcript: PathBuf,
}

pub fn run(root: &Path, artifacts: &Path) -> Result<Outcome> {
    let started = Instant::now();
    let dir = artifacts.join("vps-smoke");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir)?;
    let transcript = dir.join("transcript.txt");
    let mut log = String::new();

    if !docker_ready() {
        let line = "SKIPPED: no reachable Docker daemon, so the release smoke did NOT run and no clean-host install was proved. Start one (`dockerd &`) and re-run `cargo xtask gate --profile release`".to_owned();
        fs::write(&transcript, format!("{line}\n"))?;
        return Ok(Outcome {
            ok: std::env::var_os("CI").is_none(),
            line,
            transcript,
        });
    }

    let binary = release_binary(root)?;
    let stage = dir.join("pkg");
    let data = dir.join("data");
    let bad = dir.join("pkg-tampered");
    fs::create_dir_all(&stage)?;
    fs::create_dir_all(&data)?;
    fs::create_dir_all(&bad)?;

    // PACKAGE exactly what a release publishes: the binary, its symbol file
    // when the split DWARF produced one, SHA256SUMS, and the identity file.
    let payload = stage.join("payload");
    fs::create_dir_all(&payload)?;
    fs::copy(&binary, payload.join("centraid"))?;
    let mut symbols = "none";
    for candidate in ["centraid.dwp", "centraid.debug"] {
        let beside = binary.with_file_name(candidate);
        if beside.is_file() {
            fs::copy(&beside, payload.join(candidate))?;
            symbols = candidate;
        }
    }
    let identity = run_ok(&binary, &["--version", "--json"], root)
        .context("`centraid --version --json` — the identity stamp")?;
    let tarball = format!("centraid-{TRIPLE}.tar.gz");
    run_ok(
        Path::new("tar"),
        &[
            "-czf",
            stage.join(&tarball).to_str().context("path")?,
            "-C",
            payload.to_str().context("path")?,
            ".",
        ],
        root,
    )?;
    fs::write(
        stage.join(format!("centraid-{TRIPLE}.identity.json")),
        &identity,
    )?;
    let sums = run_ok(
        Path::new("sh"),
        &[
            "-c",
            &format!(
                "cd {} && sha256sum {tarball}",
                shell_quote(stage.to_str().context("path")?)
            ),
        ],
        root,
    )?;
    fs::write(stage.join("SHA256SUMS"), &sums)?;
    fs::copy(root.join("deploy/vps/install.sh"), stage.join("install.sh"))?;
    fs::write(stage.join("inside.sh"), INSIDE)?;

    // The TAMPERED package: the same tarball and checksums, one digest
    // character changed in the identity file. Nothing else differs, so a
    // refusal can only be the identity check.
    for name in [tarball.as_str(), "SHA256SUMS", "install.sh"] {
        fs::copy(stage.join(name), bad.join(name))?;
    }
    fs::write(
        bad.join(format!("centraid-{TRIPLE}.identity.json")),
        tamper(&identity),
    )?;

    log.push_str(&format!(
        "vps-smoke — image {BASE_IMAGE}\n  binary    {}\n  symbols   {symbols}\n  identity  {}\n  checksum  {}\n",
        binary.display(),
        identity.trim(),
        sums.trim()
    ));

    // PASS 1 and PASS 2 share the data directory, which is what makes pass 2 a
    // restart rather than a second first run.
    let mut ok = true;
    for (pass, label) in [("1", "first boot"), ("2", "restart")] {
        let output = docker(&stage, &data, &["bash", "/pkg/inside.sh", pass, TRIPLE])?;
        log.push_str(&format!(
            "\n=== pass {pass} ({label}) exit {}\n{}",
            output.0, output.1
        ));
        if output.0 != 0 {
            ok = false;
        }
    }

    // PASS 3: the negative, in its own clean container with no data directory
    // to touch.
    let refusal = docker(
        &bad,
        &data,
        &[
            "bash",
            "/pkg/install.sh",
            "--local",
            &format!("/pkg/{tarball}"),
            "--sums",
            "/pkg/SHA256SUMS",
            "--prefix",
            "/usr/local",
        ],
    )?;
    log.push_str(&format!(
        "\n=== pass 3 (tampered identity) exit {}\n{}",
        refusal.0, refusal.1
    ));
    let refused = refusal.0 != 0 && refusal.1.contains("IDENTITY MISMATCH");
    if !refused {
        ok = false;
        log.push_str(
            "\nFAIL: an artifact whose published identity does not match the binary was INSTALLED. The identity check is the whole of what stops a stale or swapped core reaching a host.\n",
        );
    }

    let seconds = started.elapsed().as_secs_f64();
    log.push_str(&format!(
        "\nvps-smoke {} in {seconds:.1}s\n",
        if ok { "PASS" } else { "FAIL" }
    ));
    fs::write(&transcript, &log)?;

    let line = if ok {
        format!(
            "clean-container install (checksum + identity verified), `gateway install --dry-run` wrote nothing, vault FOUNDED, seat paired over iroh, the RPO capture tick ran, `backup now` took a generation, `doctor` clean, container restarted over the same data directory and opened the existing vault, and the same artifact with a tampered identity REFUSED — {seconds:.1}s (the release budget is unbounded by ruling). TWO THINGS IT DOES NOT CLAIM: the WAL tail is empty because nothing writes to the vault after founding until D2's durable allowlist lands, and a restart RE-PAIRS rather than reconnecting the seat, for the same reason. Transcript: {}",
            display_relative(root, &transcript)
        )
    } else {
        format!(
            "the release smoke failed — transcript: {}",
            display_relative(root, &transcript)
        )
    };
    Ok(Outcome {
        ok,
        line,
        transcript,
    })
}

/// The script the container runs. Kept here, in one place, rather than shipped
/// under `deploy/`: it is the smoke's harness and not a deploy artifact, and a
/// copy under `deploy/` would be a second thing an operator might run.
const INSIDE: &str = r#"#!/usr/bin/env bash
set -euo pipefail
pass="$1"
triple="$2"
say() { echo "  [pass ${pass}] $*"; }

# 1. INSTALL, through the installer an operator runs. Verifies the checksum and
#    the identity stamp before anything is unpacked.
say "installing from /pkg/centraid-${triple}.tar.gz"
bash /pkg/install.sh --local "/pkg/centraid-${triple}.tar.gz" --sums /pkg/SHA256SUMS \
  --prefix /usr/local --data-dir /data
centraid --version
centraid --version --json

# 2. `gateway install --system --dry-run` WRITES NOTHING. Checked by listing the
#    unit directory before and after, not by trusting the message.
mkdir -p /etc/systemd/system
before="$(ls -A /etc/systemd/system | sort)"
say "gateway install --system --dry-run"
centraid gateway install --system --dry-run --instance smoke > /tmp/unit.txt
head -3 /tmp/unit.txt
after="$(ls -A /etc/systemd/system | sort)"
if [ "$before" != "$after" ]; then
  echo "FAIL: --dry-run wrote into /etc/systemd/system"
  exit 1
fi
grep -q '^\[Unit\]' /tmp/unit.txt
grep -q 'DynamicUser=yes' /tmp/unit.txt
say "--dry-run wrote nothing and printed a system unit"

# 3. THE GATEWAY. An empty /data on the first pass, the same /data on the
#    second. `--no-relay` because the seat is in this container: a direct path
#    over the container's own addresses, no relay and no internet.
say "starting the gateway"
( centraid gateway --data-dir /data --no-relay --print-qr \
    > /tmp/gateway.out 2> /tmp/gateway.err & echo $! > /tmp/gateway.pid ) || true
for _ in $(seq 1 60); do
  grep -q 'centraid gateway ready' /tmp/gateway.out && break
  sleep 1
done
if ! grep -q 'centraid gateway ready' /tmp/gateway.out; then
  echo "FAIL: no ready line"; tail -40 /tmp/gateway.err; exit 1
fi
head -1 /tmp/gateway.out
if [ "$pass" = "1" ]; then
  grep -q 'FOUNDED a new vault' /tmp/gateway.err || { echo "FAIL: pass 1 did not found a vault"; tail -20 /tmp/gateway.err; exit 1; }
  say "founded a vault"
else
  if grep -q 'FOUNDED a new vault' /tmp/gateway.err; then
    echo "FAIL: the restart founded a SECOND vault instead of opening the one on disk"
    exit 1
  fi
  say "opened the existing vault (no second vault founded)"
fi
grep 'centraid: vault ' /tmp/gateway.err || true

# 4. PAIRING over iroh, in-container.
ticket="$(grep -m1 '^ticket ' /tmp/gateway.out | cut -d' ' -f2)"
[ -n "$ticket" ] || { echo "FAIL: the gateway minted no ticket"; exit 1; }
say "redeeming a pair ticket (${#ticket} chars)"
# Retried, and the retry is ANNOTATED rather than absorbed — the shape the perf
# gate already uses. The first dial can land while the accept loop is still
# coming up and lose the connection; three attempts two seconds apart is the
# difference between a flaky smoke and one that reports a real refusal. If it
# needed a retry, the transcript says so.
paired=0
for attempt in 1 2 3; do
  if centraid seat pair "$ticket"; then
    paired=1
    [ "$attempt" -gt 1 ] && say "NOTE: pairing succeeded on attempt ${attempt}"
    break
  fi
  say "pairing attempt ${attempt} failed; retrying"
  sleep 2
done
[ "$paired" = "1" ] || { echo "FAIL: a seat could not pair over iroh in three attempts"; tail -20 /tmp/gateway.err; exit 1; }
say "a seat paired over iroh"

# 5. THE CAPTURE TICK. rpoSeconds is 60 and it IS the tick, so the smoke waits
#    for one and asserts THE LOOP IS ALIVE — `wal/tick.json`, which every tick
#    rewrites whether or not it sealed anything.
#
#    WHAT IS ASSERTED AND WHAT IS NOT, because the difference is the honest
#    part. The tick seals the bytes that arrived in the vault's `-wal` since the
#    last one. On this branch nothing writes to the vault after the gateway
#    founds it: pairing is recorded in an IN-MEMORY allowlist (D-1020-C8; the
#    durable `AllowlistStore` is wave 2 lane D2's), so there is no in-band
#    writer yet and a tick that sealed nothing is CORRECT rather than broken.
#    So the smoke asserts (a) the loop ran, (b) `backup now` reports the tail
#    count it actually shipped, and it PRINTS that count instead of requiring
#    it to be non-zero. The capture itself — offsets, checkpoint groups, resume
#    across a restart, a missing blob refused — is proved by unit tests in
#    `crates/centraid/src/cmd/capture.rs` over a WAL that does grow.
#
#    When D2's durable allowlist lands, pairing becomes that in-band writer and
#    the line below becomes an assertion. It is written as a printed number
#    today rather than as a disabled assertion, because a commented-out
#    assertion is how a smoke goes quiet.
say "waiting for one WAL capture tick (rpoSeconds = 60)"
for _ in $(seq 1 90); do
  [ -s /data/wal/tick.json ] && break
  sleep 1
done
if [ ! -s /data/wal/tick.json ]; then
  echo "FAIL: the capture tick recorded nothing in 90s — the RPO loop is not running"
  tail -20 /tmp/gateway.err
  exit 1
fi
cat /data/wal/tick.json
ticks="$(grep -o '"ticks": *[0-9]*' /data/wal/tick.json | grep -o '[0-9]*')"
[ "${ticks:-0}" -ge 1 ] || { echo "FAIL: wal/tick.json records zero ticks"; exit 1; }
say "the RPO loop ran ${ticks} tick(s)"
if [ -s /data/wal/pending.jsonl ]; then
  say "sealed $(wc -l < /data/wal/pending.jsonl) WAL segment(s)"
  cat /data/wal/pending.jsonl
else
  say "NO WAL SEGMENT was sealed: nothing wrote to the vault after it was founded. The first in-band writer arrives with the durable allowlist (wave 2 lane D2, D-1020-C8)."
fi

say "backup now"
centraid backup now --data-dir /data --force > /tmp/backup.json
cat /tmp/backup.json
segments="$(grep -o '"walSegments": *[0-9]*' /tmp/backup.json | grep -o '[0-9]*')"
say "generation shipped ${segments:-0} WAL segment(s)"
grep -q '"generation"' /tmp/backup.json || { echo "FAIL: backup now wrote no generation"; exit 1; }

# 6. DOCTOR, which is also the container health check.
say "doctor"
centraid doctor --data-dir /data --json
say "doctor is clean"

kill "$(cat /tmp/gateway.pid)" 2>/dev/null || true
sleep 1
say "done"
"#;

fn tamper(identity: &str) -> String {
    // One character of the digest, so the tarball, its checksum and every other
    // field are untouched and a refusal can only be the identity check.
    match identity.find("\"digest\":\"") {
        Some(at) => {
            let cut = at + "\"digest\":\"".len();
            let mut changed = identity.to_owned();
            let byte = changed.as_bytes()[cut];
            let replacement = if byte == b'z' { 'y' } else { 'z' };
            changed.replace_range(cut..cut + 1, &replacement.to_string());
            changed
        }
        None => identity.replace("dev", "notdev"),
    }
}

/// Is there a Docker daemon that answers? `docker version` succeeding for the
/// client alone is not enough — the client is on PATH in plenty of places the
/// daemon is not, and a smoke that reported "docker is present" and then failed
/// to run anything would be naming the wrong problem.
fn docker_ready() -> bool {
    Command::new("docker")
        .args(["version", "--format", "{{.Server.Version}}"])
        .output()
        .is_ok_and(|output| output.status.success())
}

/// Run one container. `/pkg` is READ-ONLY, which is what makes "the smoke does
/// not mutate what it measures" true of the package as well as the host.
fn docker(stage: &Path, data: &Path, argv: &[&str]) -> Result<(i32, String)> {
    let mut args: Vec<String> = vec![
        "run".to_owned(),
        "--rm".to_owned(),
        "-v".to_owned(),
        format!("{}:/pkg:ro", stage.display()),
        "-v".to_owned(),
        format!("{}:/data", data.display()),
        BASE_IMAGE.to_owned(),
    ];
    args.extend(argv.iter().map(|argument| (*argument).to_owned()));
    let output = Command::new("docker")
        .args(&args)
        .output()
        .context("docker run")?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok((output.status.code().unwrap_or(-1), text))
}

/// The release binary this gate run just built. `CARGO_TARGET_DIR` is honoured
/// because the whole wave shares one, and a smoke that packaged a stale binary
/// from `./target` would be smoking a different commit.
fn release_binary(root: &Path) -> Result<PathBuf> {
    let base = match std::env::var("CARGO_TARGET_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => root.join("target"),
    };
    let candidate = base.join("release/centraid");
    if candidate.is_file() {
        return Ok(candidate);
    }
    bail!(
        "no release binary at {} — the `release-build` step of this profile builds it, so an absent one means that step did not run or wrote somewhere else. `CARGO_TARGET_DIR={}`",
        candidate.display(),
        std::env::var("CARGO_TARGET_DIR").unwrap_or_else(|_| "(unset)".to_owned())
    )
}

fn run_ok(program: &Path, args: &[&str], cwd: &Path) -> Result<String> {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .with_context(|| format!("spawn {}", program.display()))?;
    if !output.status.success() {
        bail!(
            "{} {:?} exited {}: {}",
            program.display(),
            args,
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

fn display_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tamper must change the DIGEST and nothing else, or a refusal would
    /// not be evidence about the identity check.
    #[test]
    fn tampering_changes_one_digest_character_and_leaves_every_other_field() {
        let identity = "{\"dev\":false,\"digest\":\"abc123\",\"gitSha\":\"deadbeef\",\"schemaVersion\":11,\"version\":\"1.0.0\"}";
        let changed = tamper(identity);
        assert_ne!(identity, changed);
        assert_eq!(identity.len(), changed.len());
        assert!(changed.contains("\"gitSha\":\"deadbeef\""), "{changed}");
        assert!(changed.contains("\"schemaVersion\":11"), "{changed}");
        assert!(!changed.contains("\"digest\":\"abc123\""), "{changed}");
    }

    /// The container script is the harness; these are the assertions that make
    /// it a smoke rather than a script that runs some commands. If one is
    /// deleted the smoke gets quieter without getting greener, which is exactly
    /// the failure `crates/xtask/src/gate.rs` opens by naming.
    #[test]
    fn the_container_script_asserts_every_phase_the_exit_criterion_names() {
        for required in [
            "install.sh",
            "--dry-run wrote into /etc/systemd/system",
            "FOUNDED a new vault",
            "founded a SECOND vault",
            "seat pair",
            "the RPO loop is not running",
            "wal/tick.json records zero ticks",
            "backup now wrote no generation",
            "doctor --data-dir /data --json",
        ] {
            assert!(INSIDE.contains(required), "the smoke lost `{required}`");
        }
        assert!(INSIDE.contains("set -euo pipefail"));
    }

    #[test]
    fn the_base_image_is_digest_pinned() {
        assert!(BASE_IMAGE.contains("@sha256:"), "{BASE_IMAGE}");
    }
}
