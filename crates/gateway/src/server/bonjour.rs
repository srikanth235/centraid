//! HOW A GATEWAY MAKES ITSELF FOUND ON THE LAN, AND WHO MAKES THE
//! ADVERTISEMENT (#1080, Q-1080-1, answered 2026-10-15: register through
//! `dns-sd` on macOS in v1).
//!
//! A laptop that sleeps is a gateway the phone waits for, and an overnight
//! backup to it would need the laptop left awake. The network's **Bonjour
//! Sleep Proxy** answers for a sleeping Mac that has "Wake for network access"
//! on — but only for what the Mac's own `mDNSResponder` registered, so the
//! phone's browse for `_centraid-gateway._tcp` wakes the Mac only when the
//! gateway is registered *through the system*, and not when it advertises from
//! its own process with `mdns-sd` (a record the sleeping Mac can no longer
//! answer, and the proxy never held).
//!
//! | Where | Who advertises |
//! | --- | --- |
//! | macOS, with `/usr/bin/dns-sd` | **the system**: `dns-sd -R`, held by this process |
//! | macOS where that fails, Linux, a NAS, a container | **this process**: [`Advertisement`] (`mdns-sd`) |
//!
//! `--no-mdns` turns both off.
//!
//! # THE REGISTRATION LIVES AS LONG AS THE GATEWAY, AND NOT A MOMENT LONGER
//!
//! `dns-sd -R` registers while it runs and withdraws when it ends, so it is a
//! child of `serve` that must not outlive it. A plain child would survive its
//! parent's `SIGKILL` — a crash, an out-of-memory kill, a launchd restart —
//! and keep advertising a port nothing serves, so the tool is run under a
//! four-line shell whose standard input is a pipe this process holds the other
//! end of: **when the gateway goes, however it goes, the pipe closes, and the
//! shell ends the registration.** A gateway stopping cleanly closes the pipe
//! itself.
//!
//! `dns-sd` is run by absolute path with no shell interpolation (every
//! argument is a positional parameter), and it opens no listening socket:
//! `mDNSResponder` is the one that answers, which is the point.

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use crate::rules::ids::GatewayId;
use crate::server::serve::Advertisement;

/// Where macOS keeps the tool.
pub const SYSTEM_DNS_SD: &str = "/usr/bin/dns-sd";

/// The service type `dns-sd` registers: [`crate::server::serve::SERVICE_TYPE`]
/// without its domain.
pub const DNS_SD_TYPE: &str = "_centraid-gateway._tcp";

/// How long a registration is given to fail before it is taken as made. The
/// tool exits at once when `mDNSResponder` is not running, or the arguments
/// are refused.
const SETTLE: Duration = Duration::from_millis(400);

/// How often the tool is looked at while it settles.
const WATCH: Duration = Duration::from_millis(20);

/// The shell that holds `dns-sd` for as long as this process holds its
/// standard input. `$@` is the tool and its arguments, passed positionally:
/// nothing is interpolated into the script. Standard input is duplicated to
/// descriptor 3 first, because a background job's own is `/dev/null`.
const HOLD: &str = r#"exec 3<&0
"$@" </dev/null >/dev/null 2>&1 &
registered=$!
( cat <&3 >/dev/null; kill "$registered" 2>/dev/null ) &
wait "$registered""#;

/// What follows `dns-sd` on its command line to register this gateway: the
/// service's name, its type, the default domain, the port, and the TXT record a
/// phone reads — `gw` (the gateway's id) and `v=2`, the same as the in-process
/// advertisement.
#[must_use]
pub fn registration_args(gateway_id: &GatewayId, port: u16) -> Vec<String> {
    let id = gateway_id.hex();
    vec![
        "-R".to_owned(),
        format!("centraid-gateway-{}", &id[..8]),
        DNS_SD_TYPE.to_owned(),
        "local".to_owned(),
        port.to_string(),
        format!("gw={id}"),
        "v=2".to_owned(),
    ]
}

/// A registration made through the system's `dns-sd`, withdrawn when dropped.
#[derive(Debug)]
pub struct SystemRegistration {
    child: Option<Child>,
}

impl SystemRegistration {
    /// Register `port` with `program` (`dns-sd`), and answer once it has run
    /// long enough to have failed and has not.
    ///
    /// # Errors
    ///
    /// If the shell cannot start, or the tool exits at once — `mDNSResponder`
    /// not running, or the program missing.
    pub async fn start(program: &Path, gateway_id: &GatewayId, port: u16) -> std::io::Result<Self> {
        Self::start_after(program, gateway_id, port, SETTLE).await
    }

    /// [`Self::start`], judging the tool over `settle` rather than the usual wait.
    ///
    /// The tool is watched for the whole window and a failure is answered the
    /// moment it exits, so a long window costs nothing when the tool fails: only
    /// a registration that holds waits it out.
    ///
    /// # Errors
    ///
    /// As [`Self::start`].
    pub async fn start_after(
        program: &Path,
        gateway_id: &GatewayId,
        port: u16,
        settle: Duration,
    ) -> std::io::Result<Self> {
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg(HOLD)
            .arg("centraid-dns-sd")
            .arg(program)
            .args(registration_args(gateway_id, port))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        let deadline = tokio::time::Instant::now() + settle;
        loop {
            if let Some(status) = child.try_wait()? {
                return Err(std::io::Error::other(format!(
                    "{} exited at once: {status}",
                    program.display()
                )));
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Ok(Self { child: Some(child) });
            }
            tokio::time::sleep(WATCH.min(deadline - now)).await;
        }
    }
}

impl Drop for SystemRegistration {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        // CLOSING THE PIPE IS THE SIGNAL: the shell ends the registration and
        // exits. Killing the shell first would leave the tool running.
        drop(child.stdin.take());
        for _ in 0..40 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// An advertisement a gateway holds, from whoever made it. Dropping it
/// withdraws it.
#[derive(Debug)]
pub enum Announcement {
    /// Registered through the system's `dns-sd`: a sleeping Mac is woken by a
    /// browse.
    System(SystemRegistration),
    /// Advertised from this process.
    InProcess(Advertisement),
}

impl Announcement {
    /// Whether the system advertises it, and so the Bonjour Sleep Proxy holds
    /// its record while the machine sleeps.
    #[must_use]
    pub const fn is_system(&self) -> bool {
        matches!(self, Self::System(_))
    }
}

/// Advertise `port` on the LAN — through the system where macOS offers it,
/// from this process otherwise — or say why not. A gateway that cannot
/// advertise still serves: a phone's pairing record keeps the addresses it
/// last knew.
pub async fn announce(gateway_id: GatewayId, host: &str, port: u16) -> Option<Announcement> {
    #[cfg(target_os = "macos")]
    if Path::new(SYSTEM_DNS_SD).is_file() {
        match SystemRegistration::start(Path::new(SYSTEM_DNS_SD), &gateway_id, port).await {
            Ok(registration) => {
                tracing::info!(
                    host = %host,
                    "registered _centraid-gateway._tcp with the system's mDNSResponder; \
                     a sleeping Mac with \"Wake for network access\" is woken by the phone"
                );
                return Some(Announcement::System(registration));
            }
            Err(error) => tracing::warn!(
                %error,
                "the system's dns-sd would not register; advertising from this process instead"
            ),
        }
    }
    match Advertisement::start(gateway_id, host, port) {
        Ok(advertisement) => {
            tracing::info!(host = %host, "advertising _centraid-gateway._tcp");
            Some(Announcement::InProcess(advertisement))
        }
        Err(error) => {
            tracing::warn!(%error, "not advertising on the LAN");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    fn id() -> GatewayId {
        "0123456789abcdef0123456789abcdef"
            .parse()
            .expect("a gateway id")
    }

    /// **WHAT IS REGISTERED IS WHAT A PHONE BROWSES FOR**: the in-process
    /// advertisement's service type, TXT record and port, in `dns-sd`'s own
    /// argument order — `-R name type domain port txt...`.
    #[test]
    fn the_registration_is_the_advertisement_a_phone_browses_for() {
        assert_eq!(
            format!("{DNS_SD_TYPE}.local."),
            crate::server::serve::SERVICE_TYPE,
            "one service, whoever registers it"
        );
        assert_eq!(
            registration_args(&id(), 8443),
            vec![
                "-R",
                "centraid-gateway-01234567",
                "_centraid-gateway._tcp",
                "local",
                "8443",
                "gw=0123456789abcdef0123456789abcdef",
                "v=2"
            ]
        );
    }

    /// A stand-in for `dns-sd`: it records its process id and its arguments
    /// where the test reads them, then stays registered until it is killed.
    fn fake_dns_sd(dir: &Path, body: &str) -> std::path::PathBuf {
        let program = dir.join("dns-sd");
        std::fs::write(&program, format!("#!/bin/sh\n{body}\n")).expect("writes");
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        program
    }

    fn alive(pid: &str) -> bool {
        Command::new("kill")
            .args(["-0", pid])
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    /// How long a fake is given to START. A fake is a file written a moment
    /// ago, and on macOS the first exec of a new executable waits on the
    /// system's code assessment, which it runs one file at a time: about half
    /// a second each on the owner's Mac, and 7.7 s for sixteen written at once
    /// (2026-10-21). Under a parallel gate a fake can start seconds late, so a
    /// fixed few seconds was a guess about the rest of the machine. Every wait
    /// answers the moment its condition holds; this only bounds a failure.
    const FIRST_EXEC: Duration = Duration::from_secs(60);

    /// The line a fake noted at `path`, once it is WHOLE. The shell creates the
    /// file before `echo` writes into it, so a file that exists can still be
    /// empty; `echo` writes its line in one `write`, so a file that ends in a
    /// newline holds all of it.
    async fn noted(path: &Path) -> Option<String> {
        let deadline = tokio::time::Instant::now() + FIRST_EXEC;
        loop {
            match std::fs::read_to_string(path) {
                Ok(line) if line.ends_with('\n') => return Some(line.trim().to_owned()),
                _ if tokio::time::Instant::now() >= deadline => return None,
                _ => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
    }

    /// `done` holds within five seconds: for a process already running, which
    /// no assessment delays.
    async fn eventually(mut done: impl FnMut() -> bool) -> bool {
        for _ in 0..100 {
            if done() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    /// **THE TOOL IS RUN WITH THE REGISTRATION'S ARGUMENTS, STAYS WHILE THE
    /// GATEWAY HOLDS IT, AND GOES WHEN IT LETS GO** (Q-1080-1). Nothing here
    /// needs a network: the program is a script that notes what it was asked.
    #[tokio::test]
    async fn dns_sd_is_run_with_the_registration_and_withdrawn_when_dropped() {
        let dir = tempfile::tempdir().expect("a directory");
        let notes = dir.path().join("noted");
        let program = fake_dns_sd(
            dir.path(),
            &format!(
                "echo $$ > {notes}.pid\necho \"$@\" > {notes}.args\nexec sleep 60",
                notes = notes.display()
            ),
        );
        let registration = SystemRegistration::start(&program, &id(), 8443)
            .await
            .expect("the tool stays registered");
        let pid = noted(&dir.path().join("noted.pid"))
            .await
            .expect("the tool ran and noted itself");
        let args = noted(&dir.path().join("noted.args"))
            .await
            .expect("the tool noted its arguments");
        assert_eq!(
            args,
            "-R centraid-gateway-01234567 _centraid-gateway._tcp local 8443 \
             gw=0123456789abcdef0123456789abcdef v=2"
        );
        assert!(alive(&pid), "registered while the gateway holds it");

        drop(registration);
        assert!(
            eventually(|| !alive(&pid)).await,
            "dropping the registration ends the tool"
        );
    }

    /// **A TOOL THAT EXITS AT ONCE IS A FAILURE, NOT A REGISTRATION**:
    /// `mDNSResponder` not running, or the program not there. The gateway then
    /// advertises from its own process, and still serves.
    #[tokio::test]
    async fn a_tool_that_exits_at_once_is_not_a_registration() {
        let dir = tempfile::tempdir().expect("a directory");
        let failing = fake_dns_sd(dir.path(), "exit 3");
        // The window is the fake's first exec, not a guess at "at once": a
        // failure is answered the moment the tool exits, however late it ran.
        let error = SystemRegistration::start_after(&failing, &id(), 8443, FIRST_EXEC)
            .await
            .expect_err("it exited");
        assert!(error.to_string().contains("exited at once"), "{error}");
        let missing = dir.path().join("no-such-dns-sd");
        assert!(
            SystemRegistration::start_after(&missing, &id(), 8443, FIRST_EXEC)
                .await
                .is_err(),
            "a program that is not there registers nothing"
        );
    }

    /// **THE REGISTRATION DOES NOT OUTLIVE A GATEWAY THAT WAS KILLED** (the
    /// module header): the shell's standard input is a pipe only the gateway
    /// holds, so its closing — which is what a `SIGKILL` does — ends the tool.
    /// Closed here by taking the pipe away without the registration's own
    /// cleanup.
    #[tokio::test]
    async fn a_pipe_that_closes_ends_the_tool_without_the_gateway_saying_so() {
        let dir = tempfile::tempdir().expect("a directory");
        let program = fake_dns_sd(
            dir.path(),
            &format!(
                "echo $$ > {pid}\nexec sleep 60",
                pid = dir.path().join("pid").display()
            ),
        );
        let mut registration = SystemRegistration::start(&program, &id(), 8443)
            .await
            .expect("registered");
        let pid = noted(&dir.path().join("pid"))
            .await
            .expect("the tool ran and noted itself");
        assert!(alive(&pid));
        // What the kernel does when the gateway dies: close its end.
        let child = registration.child.as_mut().expect("held");
        drop(child.stdin.take());
        assert!(
            eventually(|| !alive(&pid)).await,
            "the tool ended because nobody holds the pipe"
        );
    }
}
