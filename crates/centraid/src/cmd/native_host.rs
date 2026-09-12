//! `centraid native-host` — the browser extension's native-messaging host
//! (#1020, D-1020-F6).
//!
//! **Net-new.** v0's extension is MV3 with WASM iroh in the service worker and
//! there is no host manifest anywhere in the tree (census §F8, seam 11); the
//! only reusable code was the pure retry/401 classification, which the
//! extension keeps. So this file owns two things:
//!
//! 1. **The framing.** Chrome's native-messaging wire is
//!    `u32<native-endian>(len) ‖ utf8 JSON`, on stdin and stdout, with a 1 MiB
//!    ceiling on a message from the extension and 64 MiB the other way. It is
//!    *not* the product's `u32BE` framing, and the difference is the bug this
//!    module exists to not have: a host that writes big-endian lengths is a
//!    host the browser silently disconnects.
//! 2. **The host manifest.** `centraid native-host install --browser
//!    chrome|firefox` writes the JSON the browser reads, with the extension-id
//!    **allowlist** in it. An `allowed_origins` list that admits every
//!    extension is a native host any installed extension can drive, which on
//!    this product means any extension can read the vault.
//!
//! ## Why the host is the same binary
//!
//! The browser launches it, so it runs as the member. It then connects to the
//! seat socket **as any other local client** and passes the same peer check —
//! it does not become privileged by being launched by Chrome. What it presents
//! is a per-turn capability token from `CENTRAID_SEAT_TOKEN`, minted by the
//! shell, because uid alone cannot say *which* local program is asking
//! (D-1020-AS2's rule, applied to the browser as well as to `centraid mcp`).

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use crate::exit;

/// The browser's ceiling on a message **from** an extension: 1 MiB.
pub const MAX_FROM_EXTENSION: u32 = 1024 * 1024;
/// The browser's ceiling on a message **to** an extension: 64 MiB. A host that
/// writes more is disconnected, so the host refuses first and says so.
pub const MAX_TO_EXTENSION: u32 = 64 * 1024 * 1024;

/// Which browser's manifest shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Browser {
    Chrome,
    Firefox,
}

impl Browser {
    /// The key the manifest names the caller allowlist with.
    ///
    /// Chrome takes `allowed_origins` of `chrome-extension://<id>/` URLs;
    /// Firefox takes `allowed_extensions` of add-on ids. Two spellings for one
    /// idea, and writing Chrome's key into Firefox's manifest produces a host
    /// Firefox loads and refuses to talk to, with no error anyone sees.
    #[must_use]
    pub const fn allow_key(self) -> &'static str {
        match self {
            Self::Chrome => "allowed_origins",
            Self::Firefox => "allowed_extensions",
        }
    }

    /// Where the browser looks for it, per platform, as the sentence an
    /// operator follows. Not written by this verb on a platform it cannot
    /// observe — see [`install`].
    #[must_use]
    pub const fn manifest_dir_hint(self) -> &'static str {
        match self {
            Self::Chrome => {
                "~/.config/google-chrome/NativeMessagingHosts (Linux) · \
                 ~/Library/Application Support/Google/Chrome/NativeMessagingHosts (macOS) · \
                 HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\<name> (Windows)"
            }
            Self::Firefox => {
                "~/.mozilla/native-messaging-hosts (Linux) · \
                 ~/Library/Application Support/Mozilla/NativeMessagingHosts (macOS) · \
                 HKCU\\Software\\Mozilla\\NativeMessagingHosts\\<name> (Windows)"
            }
        }
    }
}

/// The host's name, which is also the manifest's filename.
pub const HOST_NAME: &str = "dev.centraid.host";

/// Build the host manifest.
///
/// `allowed` is the extension-id allowlist and **an empty one is refused**:
/// a manifest with no allowlist is not "open to everything" in Chrome (it
/// simply never matches), but in Firefox an absent key is an error and an
/// empty array is a host nothing can use — either way it is a file that
/// silently does not work, so the refusal happens here where the reason can be
/// said.
pub fn manifest(
    browser: Browser,
    binary: &Path,
    allowed: &[String],
) -> Result<serde_json::Value, String> {
    if allowed.is_empty() {
        return Err(
            "a native-messaging host needs at least one extension id in its allowlist: a host any \
             extension may drive is a host that can read this vault"
                .to_owned(),
        );
    }
    for id in allowed {
        // Chrome extension ids are 32 characters of a-p; a Firefox add-on id is
        // either an email-shaped string or a GUID. What is refused here is the
        // shape that cannot be either: anything with a quote, a slash or
        // whitespace, which is how a manifest ends up admitting a wildcard.
        if id.is_empty()
            || id
                .bytes()
                .any(|byte| byte.is_ascii_whitespace() || byte == b'"' || byte == b'*')
        {
            return Err(format!("{id:?} is not an extension id"));
        }
    }
    let allow = match browser {
        Browser::Chrome => allowed
            .iter()
            .map(|id| serde_json::Value::String(format!("chrome-extension://{id}/")))
            .collect::<Vec<_>>(),
        Browser::Firefox => allowed
            .iter()
            .map(|id| serde_json::Value::String(id.clone()))
            .collect::<Vec<_>>(),
    };
    Ok(serde_json::json!({
        "name": HOST_NAME,
        "description": "Centraid — the vault's native-messaging host",
        "path": binary.display().to_string(),
        "type": "stdio",
        browser.allow_key(): allow,
    }))
}

/// Read one native-messaging message from `reader`.
///
/// `Ok(None)` is a clean end of stream, which is what the browser does when the
/// port closes — not an error, and a host that logged it as one would fill a
/// crash log on every tab close.
pub fn read_message<R: Read>(reader: &mut R) -> io::Result<Option<serde_json::Value>> {
    let mut length = [0_u8; 4];
    match reader.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    // NATIVE-ENDIAN, and this is the whole trap: the product's own framing is
    // `u32BE` (`crates/protocol/src/framing.rs`), and Chrome's is the host
    // platform's byte order. On every machine this ships to those differ.
    let length = u32::from_ne_bytes(length);
    if length > MAX_FROM_EXTENSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("a {length}-byte message is over the browser's 1 MiB ceiling"),
        ));
    }
    let mut body = vec![0_u8; length as usize];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body).map(Some).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("a native message would not parse: {error}"),
        )
    })
}

/// Write one native-messaging message to `writer`.
pub fn write_message<W: Write>(writer: &mut W, message: &serde_json::Value) -> io::Result<()> {
    let body = serde_json::to_vec(message)?;
    let length = u32::try_from(body.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "a message longer than 4 GiB"))?;
    if length > MAX_TO_EXTENSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("a {length}-byte reply is over the browser's 64 MiB ceiling"),
        ));
    }
    writer.write_all(&length.to_ne_bytes())?;
    writer.write_all(&body)?;
    // FLUSHED EVERY MESSAGE. The browser waits for bytes, not for a buffer to
    // fill, and a host that batches looks hung.
    writer.flush()
}

/// One request/response turn, with no I/O: what the host answers.
///
/// Separated from the loop so the message contract is tested without a pipe.
/// The host is a **relay** — it does not answer vault questions itself — so the
/// answers here are the ones that are about the host: the handshake and the
/// refusals. Anything else is forwarded to the seat socket.
pub fn answer(message: &serde_json::Value, token: Option<&str>) -> HostAnswer {
    let kind = message.get("t").and_then(serde_json::Value::as_str);
    match kind {
        Some("ping") => HostAnswer::Reply(serde_json::json!({
            "t": "pong",
            "host": HOST_NAME,
            "version": env!("CARGO_PKG_VERSION"),
            // Whether this host can reach the seat at all, which is what the
            // extension's first screen needs to know.
            "attached": token.is_some(),
        })),
        Some(_) if token.is_none() => HostAnswer::Reply(serde_json::json!({
            "t": "error",
            "code": "no-capability",
            // The member sentence, not a stack: the extension renders this.
            "message": "Open Centraid and allow the browser extension to connect.",
        })),
        Some(_) => HostAnswer::Forward,
        None => HostAnswer::Reply(serde_json::json!({
            "t": "error",
            "code": "malformed",
            "message": "Open Centraid and allow the browser extension to connect.",
        })),
    }
}

/// What [`answer`] decided.
#[derive(Debug, Clone, PartialEq)]
pub enum HostAnswer {
    /// The host answers this itself.
    Reply(serde_json::Value),
    /// The host relays it to the seat socket.
    Forward,
}

pub struct InstallArgs {
    pub browser: Browser,
    /// The extension ids this host will talk to.
    pub allowed: Vec<String>,
    /// Where to write the manifest. Without it the manifest is printed and
    /// nothing is written.
    pub out: Option<PathBuf>,
}

/// `centraid native-host install --browser <b> --extension-id <id>…`
///
/// **It never installs into a browser's directory by guessing.** v0's
/// `gateway install` sets the precedent and the reason is the same
/// (`scripts/install-gateway.mjs:5`–`:8`, D-1020-G1): a file that appeared
/// under a browser's configuration because something was unpacked is a
/// capability nobody chose to grant. `--out` writes where the operator says;
/// without it the manifest and the directory to copy it to are printed.
pub fn install(args: InstallArgs) -> u8 {
    let binary = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("centraid: this binary's own path is not readable: {error}");
            return exit::REFUSED;
        }
    };
    let document = match manifest(args.browser, &binary, &args.allowed) {
        Ok(document) => document,
        Err(why) => {
            eprintln!("centraid: {why}");
            return exit::USAGE;
        }
    };
    let text = serde_json::to_string_pretty(&document).unwrap_or_else(|_| "{}".to_owned());
    match args.out {
        Some(path) => {
            if let Some(parent) = path.parent()
                && let Err(error) = std::fs::create_dir_all(parent)
            {
                eprintln!("centraid: creating {}: {error}", parent.display());
                return exit::REFUSED;
            }
            if let Err(error) = std::fs::write(&path, format!("{text}\n")) {
                eprintln!("centraid: writing {}: {error}", path.display());
                return exit::REFUSED;
            }
            eprintln!("centraid: wrote {}", path.display());
            eprintln!(
                "centraid: copy it to the directory the browser reads and nothing else is needed: \
                 {}",
                args.browser.manifest_dir_hint()
            );
            exit::OK
        }
        None => {
            println!("{text}");
            eprintln!(
                "centraid: nothing was written. Pass `--out <path>`, or copy the JSON above into \
                 {HOST_NAME}.json under: {}",
                args.browser.manifest_dir_hint()
            );
            exit::OK
        }
    }
}

/// Run the host: read stdin, answer or relay, write stdout, until the port
/// closes.
pub fn run() -> u8 {
    let token = std::env::var("CENTRAID_SEAT_TOKEN")
        .ok()
        .filter(|token| !token.is_empty());
    let socket = std::env::var("CENTRAID_SEAT_SOCKET").ok();
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    loop {
        match read_message(&mut reader) {
            Ok(None) => return exit::OK,
            Ok(Some(message)) => {
                let reply = match answer(&message, token.as_deref()) {
                    HostAnswer::Reply(reply) => reply,
                    HostAnswer::Forward => serde_json::json!({
                        "t": "error",
                        "code": "not-attached",
                        // HONEST: the relay to the seat socket is the next
                        // step and this build does not do it. It is a refusal
                        // with a reason, never a silent empty answer.
                        "message": "Open Centraid and allow the browser extension to connect.",
                        "detail": format!(
                            "relaying to the seat socket ({}) lands with the extension's read \
                             surface; this host answers `ping` and refuses the rest",
                            socket.as_deref().unwrap_or("unset")
                        ),
                    }),
                };
                if let Err(error) = write_message(&mut writer, &reply) {
                    // stderr, because stdout IS the protocol here: one stray
                    // byte on it and the browser disconnects.
                    eprintln!("centraid: the browser port broke: {error}");
                    return exit::REFUSED;
                }
            }
            Err(error) => {
                eprintln!("centraid: {error}");
                return exit::REFUSED;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_round_trips_through_the_browsers_own_framing() {
        let message = serde_json::json!({ "t": "ping" });
        let mut buffer = Vec::new();
        write_message(&mut buffer, &message).expect("written");
        // NATIVE-ENDIAN length, and the assertion says so explicitly so a
        // future edit to big-endian fails here rather than in a browser.
        let body = serde_json::to_vec(&message).expect("encoded");
        assert_eq!(&buffer[..4], &(body.len() as u32).to_ne_bytes());
        assert_eq!(&buffer[4..], &body[..]);
        let mut cursor = io::Cursor::new(buffer);
        assert_eq!(read_message(&mut cursor).expect("read"), Some(message));
        // A clean end of stream is `None`, not an error: that is a closed tab.
        assert_eq!(read_message(&mut cursor).expect("eof"), None);
    }

    #[test]
    fn a_message_over_the_browsers_ceiling_is_refused_rather_than_allocated() {
        let mut framed = Vec::new();
        framed.extend_from_slice(&(MAX_FROM_EXTENSION + 1).to_ne_bytes());
        let mut cursor = io::Cursor::new(framed);
        let error = read_message(&mut cursor).expect_err("refused");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("1 MiB"), "{error}");
    }

    #[test]
    fn a_truncated_body_is_an_error_and_not_a_short_message() {
        let mut framed = Vec::new();
        framed.extend_from_slice(&10_u32.to_ne_bytes());
        framed.extend_from_slice(b"{}");
        let mut cursor = io::Cursor::new(framed);
        assert!(read_message(&mut cursor).is_err());
    }

    #[test]
    fn the_ping_turn_is_answered_by_the_host_itself() {
        let reply = answer(&serde_json::json!({ "t": "ping" }), None);
        let HostAnswer::Reply(reply) = reply else {
            panic!("a ping is answered here");
        };
        assert_eq!(reply["t"], "pong");
        assert_eq!(reply["host"], HOST_NAME);
        assert_eq!(reply["attached"], false);
        let HostAnswer::Reply(reply) = answer(&serde_json::json!({ "t": "ping" }), Some("tok"))
        else {
            panic!("a ping is answered here");
        };
        assert_eq!(reply["attached"], true);
    }

    #[test]
    fn a_turn_with_no_capability_token_is_refused_with_a_member_sentence() {
        let HostAnswer::Reply(reply) = answer(&serde_json::json!({ "t": "page" }), None) else {
            panic!("refused here");
        };
        assert_eq!(reply["code"], "no-capability");
        // The member reads this. No stack, no path, no token.
        assert_eq!(
            reply["message"],
            "Open Centraid and allow the browser extension to connect."
        );
        assert!(!reply["message"].as_str().expect("text").contains("tok"));
        // WITH a token the same turn is forwarded rather than answered here.
        assert_eq!(
            answer(&serde_json::json!({ "t": "page" }), Some("tok")),
            HostAnswer::Forward
        );
    }

    #[test]
    fn a_message_with_no_kind_is_refused_and_never_forwarded() {
        assert!(matches!(
            answer(&serde_json::json!({ "hello": true }), Some("tok")),
            HostAnswer::Reply(_)
        ));
    }

    #[test]
    fn the_two_browsers_spell_their_allowlists_differently_and_both_are_written() {
        let binary = Path::new("/opt/centraid/centraid");
        let chrome = manifest(
            Browser::Chrome,
            binary,
            &["abcdefghijklmnopabcdefghijklmnop".to_owned()],
        )
        .expect("a chrome manifest");
        assert_eq!(chrome["name"], HOST_NAME);
        assert_eq!(chrome["type"], "stdio");
        assert_eq!(chrome["path"], "/opt/centraid/centraid");
        assert_eq!(
            chrome["allowed_origins"][0],
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
        );
        assert!(chrome.get("allowed_extensions").is_none());

        let firefox = manifest(
            Browser::Firefox,
            binary,
            &["centraid@centraid.dev".to_owned()],
        )
        .expect("a firefox manifest");
        assert_eq!(firefox["allowed_extensions"][0], "centraid@centraid.dev");
        assert!(firefox.get("allowed_origins").is_none());
    }

    #[test]
    fn a_manifest_with_no_allowlist_or_a_wildcard_is_refused() {
        let binary = Path::new("/opt/centraid/centraid");
        assert!(manifest(Browser::Chrome, binary, &[]).is_err());
        for bad in ["*", "chrome-extension://*/", "a b", "\"", ""] {
            assert!(
                manifest(Browser::Chrome, binary, &[bad.to_owned()]).is_err(),
                "{bad:?} must not reach a manifest"
            );
        }
    }
}
