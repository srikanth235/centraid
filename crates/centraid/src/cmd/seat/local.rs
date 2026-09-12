//! The seat socket's **local** channel: what crosses a 0600 socket and nothing
//! else (#1020, D-1020-F2, D-1020-F9).
//!
//! ## Two channels in one frame, and why
//!
//! A frame on the seat socket is `crates/protocol`'s framing verbatim —
//! `u32BE(len) ‖ body`, `len <= MAX_FRAME_BYTES` — with the **first byte of the
//! body a channel tag**:
//!
//! | Tag | Body | Who speaks it |
//! |---|---|---|
//! | [`CHANNEL_CORE`] | a `centraid.core.v1.Envelope`, byte-identical to what crosses iroh | a native client (`centraid mcp`, a Rust test) |
//! | [`CHANNEL_LOCAL`] | one UTF-8 JSON [`ClientMessage`] / [`SeatMessage`] | this window's Electron main |
//!
//! **Why the local channel is not in `centraid.core.v1`.** Every message here
//! names something that cannot exist on a remote wire: a peer uid, a socket
//! path, a byte offset into a file this process can see, a capability token
//! minted for a child process on this machine. `centraid.core.v1` carries a
//! `buf breaking` FILE promise to seats that update on their own schedule
//! (`buf.yaml`), and putting local-only messages under that promise would
//! commit the gateway to a shape no remote peer can ever receive. The core
//! channel is the one that crosses versions, and it is unchanged.
//!
//! **Why JSON on the local channel.** Both ends are on one machine, shipped in
//! one artifact, and the consumer is Electron main — a JSON line is readable in
//! a crash log and needs no code generation step in the desktop build. The
//! core channel stays protobuf precisely because it is the one that must not
//! depend on a language's JSON habits.
//!
//! ## Three client kinds, one credential
//!
//! The socket *is* the credential (mode 0600 plus the peer-uid check in
//! [`super::peer`], R-1020-26). What a [`ClientMessage::Hello`] adds is *which*
//! local client this is:
//!
//! - [`ClientKind::Renderer`] — this window's Electron main. Proves the
//!   **instance nonce** the sidecar was spawned with, so a renderer belonging to
//!   another install of the same product cannot adopt this seat (seam F4).
//! - [`ClientKind::Mcp`] — `centraid mcp`, a stdio child with **no** nonce and a
//!   per-turn capability token instead (D-1020-AS2). The renderer mints one
//!   through [`ClientMessage::MintCapability`] and puts it in the child's
//!   environment; the token is single-use and expires.
//! - [`ClientKind::NativeHost`] — `centraid native-host`, launched by a browser.
//!   Same peer check, same per-turn token: a browser-launched process runs as
//!   the user, so uid alone does not say *which* local program is asking.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A `centraid.core.v1.Envelope`, as on iroh.
pub const CHANNEL_CORE: u8 = 0x00;
/// One JSON local-plane message.
pub const CHANNEL_LOCAL: u8 = 0x01;

/// The local plane's own version. Bumped when a message changes shape; the
/// renderer and the sidecar ship in one artifact, so the window is exact
/// equality rather than the core channel's arithmetic window.
pub const LOCAL_PROTOCOL_VERSION: u32 = 1;

/// Split a frame body into its channel tag and payload.
///
/// An empty body is not a channel-0 frame with no envelope: it is a frame a
/// writer produced with no tag at all, and answering it as core traffic would
/// mean decoding zero bytes into a default `Envelope` and serving it.
pub fn split_channel(body: &[u8]) -> Option<(u8, &[u8])> {
    let (tag, rest) = body.split_first()?;
    Some((*tag, rest))
}

/// Prefix a payload with its channel tag.
#[must_use]
pub fn tagged(channel: u8, payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(payload.len() + 1);
    body.push(channel);
    body.extend_from_slice(payload);
    body
}

/// Which local program is on the other end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClientKind {
    /// This window's Electron main process.
    Renderer,
    /// `centraid mcp`, a stdio child of the shell (D-1020-AS2).
    Mcp,
    /// `centraid native-host`, launched by a browser (D-1020-F6).
    NativeHost,
}

impl ClientKind {
    /// Whether this kind may mint capability tokens for other kinds.
    ///
    /// Only the renderer: it is the process the member is looking at, and a
    /// child that could mint its own token would make the token decorative.
    #[must_use]
    pub const fn may_mint(self) -> bool {
        matches!(self, Self::Renderer)
    }

    /// Whether this kind proves the spawn nonce rather than a capability token.
    #[must_use]
    pub const fn proves_nonce(self) -> bool {
        matches!(self, Self::Renderer)
    }
}

/// What the seat's mode is, for the shell's four visible states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SeatMode {
    /// A full local replica (`crates/seat`'s plane).
    Replicated,
    /// No local rows: every call is forwarded under the caller's principal.
    Thin,
}

/// Client → seat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMessage {
    /// The first local-channel message on a connection.
    Hello {
        client: ClientKind,
        /// The spawn nonce, for [`ClientKind::Renderer`].
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nonce: Option<String>,
        /// A capability token, for every other kind.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token: Option<String>,
        protocol: u32,
    },
    /// A named paged read. **Not** a free-form query: the catalogue lives in
    /// the sidecar (`super::catalogue`), so a renderer cannot compose a read
    /// the seat did not ship.
    Page {
        id: u64,
        statement: String,
        limit: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after: Option<PageCursorJson>,
    },
    /// Invoke a command by name with a JSON input.
    Command {
        id: u64,
        name: String,
        input: serde_json::Value,
    },
    /// The enrolled devices.
    DevicesList { id: u64 },
    /// One blob's size, media type and how much of it has arrived.
    BlobStat { id: u64, blob: String },
    /// A byte range of one blob, waiting up to `wait_ms` for bytes that have
    /// not arrived yet (D-1020-F3).
    ///
    /// `range` is **the raw `Range` header**, not a parsed pair. One grammar,
    /// in one place: the header's suffix form, its open-range clamp and its
    /// refusals are ported once into `super::blob::parse_range` and tested
    /// against v0's own cases. A parsed pair on the wire would mean the shell
    /// carried a second copy of that grammar, and two copies of a grammar is
    /// how a `bytes=-10` starts meaning different things at each end.
    BlobRange {
        id: u64,
        blob: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        range: Option<String>,
        #[serde(default)]
        wait_ms: u64,
    },
    /// Mint a per-turn capability token for a child process. Renderer only.
    MintCapability {
        id: u64,
        client: ClientKind,
        purpose: String,
        ttl_ms: u64,
    },
    /// Send the current [`SeatStateJson`] now, and on every change after.
    SubscribeState { id: u64 },
    /// The terminal command: stop serving and close. What quit sends before it
    /// signals (D-1020-F1).
    Terminate { id: u64 },
}

/// Seat → client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum SeatMessage {
    /// The handshake answer. `instance` is what an adoption probe compares.
    HelloOk {
        instance: String,
        mode: SeatMode,
        protocol: u32,
        schema_version: u32,
        min_supported: u32,
        product_version: String,
    },
    /// The handshake was refused. Always the last message on the connection.
    Refused { code: RefusalCode, message: String },
    /// A request answered.
    Result { id: u64, value: serde_json::Value },
    /// A request refused.
    Error {
        id: u64,
        code: String,
        message: String,
    },
    /// A page of rows, columns named once rather than per row.
    Page {
        id: u64,
        columns: Vec<String>,
        rows: Vec<Vec<serde_json::Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next: Option<PageCursorJson>,
    },
    /// A blob's shape.
    BlobStat {
        id: u64,
        /// The declared total, when the blob's size is known even though its
        /// bytes are still arriving. `None` only for a blob nothing declared.
        total: Option<u64>,
        received: u64,
        complete: bool,
        media_type: String,
        /// Whether this media type is ever served inline (D-1020-F3).
        inline: bool,
    },
    /// Bytes. `start`..=`end` inclusive, base64, and **possibly shorter than
    /// the range asked for** — because the blob is still arriving, or because
    /// one frame carries at most `blob::MAX_CHUNK_BYTES`. `end` is what was
    /// served, not what was requested.
    BlobBytes {
        id: u64,
        start: u64,
        end: u64,
        /// The last byte of the range the seat RESOLVED, before the frame
        /// ceiling clamped it. The shell needs it to set an honest
        /// `Content-Length` and to know how many more windows to pull: it
        /// cannot re-derive it, because the `Range` grammar (and its open-range
        /// clamp) lives here.
        req_end: u64,
        total: Option<u64>,
        complete: bool,
        /// Whether the client asked with a `Range` header. `false` means the
        /// shell answers `200`, `true` means `206` — the distinction the HTTP
        /// layer cannot re-derive, because a full GET of an arriving blob is
        /// also served short.
        partial: bool,
        bytes_b64: String,
    },
    /// The four states, as one message (D-1020-F4).
    State {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<u64>,
        state: SeatStateJson,
    },
    /// The seat is closing. Sent before the socket goes away, so a shell can
    /// tell "the seat said goodbye" from "the seat died".
    Closing { reason: String },
}

/// Why a handshake was refused. Distinct codes rather than one `invalid`,
/// because the shell's next action differs for each — port of the updater's
/// twelve-reason rule (census §F seam 7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RefusalCode {
    /// The peer's uid is not this seat's uid (R-1020-26).
    ForeignPeer,
    /// The local protocol version is not this build's.
    ProtocolMismatch,
    /// A renderer with the wrong instance nonce: another install's shell.
    ForeignInstance,
    /// A renderer with no nonce at all.
    NonceMissing,
    /// A child with no capability token.
    TokenMissing,
    /// A token this seat never minted, or minted for another kind.
    TokenUnknown,
    /// A token that has expired or been spent.
    TokenSpent,
    /// A second message before `Hello`.
    HandshakeExpected,
    /// A frame that is not a message this build knows.
    Unsupported,
    /// A mint asked for by a client that may not mint.
    NotPermitted,
}

impl RefusalCode {
    /// The member- or operator-readable sentence. One per code, so a support
    /// bundle carries a reason and not a number.
    #[must_use]
    pub const fn sentence(self) -> &'static str {
        match self {
            Self::ForeignPeer => "that connection comes from another user account on this machine",
            Self::ProtocolMismatch => {
                "the shell and the seat process are from different builds — reinstall Centraid"
            }
            Self::ForeignInstance => {
                "that shell belongs to a different Centraid install; this seat serves the window \
                 that started it"
            }
            Self::NonceMissing => "a shell must prove the instance nonce it started this seat with",
            Self::TokenMissing => "this client needs a capability token the shell mints for it",
            Self::TokenUnknown => "this seat did not mint that capability token",
            Self::TokenSpent => "that capability token has expired or was already used",
            Self::HandshakeExpected => "the first local message on a connection must be `hello`",
            Self::Unsupported => "this build does not know that message",
            Self::NotPermitted => "only the shell may mint capability tokens",
        }
    }
}

/// The keyset cursor, as JSON. `sort_key` is TEXT even for a numeric sort
/// column and a NULL sort key collapses to the empty string — `query.proto`'s
/// rule, restated here because a JSON reader that "helpfully" omits an empty
/// string produces a cursor v0's fixtures do not reproduce.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageCursorJson {
    pub sort_key: String,
    pub pk: String,
}

/// The **four** states, in one message (D-1020-F4).
///
/// One message and not four subscriptions, because they are read together: a
/// shell that has availability but not durability draws a different screen from
/// one that has both, and two arrivals means one frame drawn from a state that
/// never existed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SeatStateJson {
    /// **Availability** — can this seat answer a read at all right now.
    pub availability: Availability,
    /// **Durability** — is what the member wrote known to survive.
    pub durability: Durability,
    /// **Pending work** — how much this seat owes the gateway.
    pub pending_work: PendingWork,
    /// **Connectivity** — the gateway link.
    pub connectivity: Connectivity,
    /// The seat's mode, so a shell need not remember how it was started.
    pub mode: SeatMode,
    /// Epoch ms this state was folded at.
    pub at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Availability {
    /// Reads answer from local rows.
    Local,
    /// Reads answer, but only by reaching the gateway (a thin seat).
    Forwarded,
    /// Reads cannot be answered. A thin seat with no gateway is HERE, and the
    /// shell draws "nothing to show" — never an empty list (the three-state
    /// read law).
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Durability {
    /// Committed here and acknowledged by the gateway.
    Settled,
    /// Committed here; the gateway has not acknowledged it.
    LocalOnly,
    /// Nothing is committed locally at all (a thin seat).
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingWork {
    /// Intents in the outbox the gateway has not settled.
    pub outbox: u32,
    /// Log entries behind the gateway's watermark, when known.
    pub behind: u64,
    /// Whether the event queue has stalled (the core's bounded queue, full).
    pub stalled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Connectivity {
    /// The gateway answered.
    Online,
    /// The gateway did not answer.
    Offline,
    /// No gateway is configured yet (first run). Not "offline": the member has
    /// not chosen one, and the two screens are different.
    Unconfigured,
}

/// A capability token this seat minted, and what it admits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capability {
    pub client: ClientKind,
    pub purpose: String,
    pub expires_at_ms: u64,
}

/// The live capability tokens, keyed by token.
///
/// A pure map with an explicit clock, so the expiry and single-use rules are
/// tested without waiting (`crates/centraid/src/cmd/seat/local.rs` tests).
#[derive(Debug, Default)]
pub struct Capabilities {
    live: BTreeMap<String, Capability>,
}

/// The longest a capability token may live. A per-turn token that outlives the
/// turn is a bearer credential on disk in some child's environment.
pub const MAX_CAPABILITY_TTL_MS: u64 = 10 * 60 * 1000;

impl Capabilities {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a minted token. `ttl_ms` is clamped, never refused: a shell that
    /// asks for an hour gets ten minutes and a token, not an error screen.
    pub fn mint(
        &mut self,
        token: String,
        client: ClientKind,
        purpose: String,
        now_ms: u64,
        ttl_ms: u64,
    ) -> u64 {
        // Clamped, never refused: a shell that asks for an hour gets ten
        // minutes and a token, not an error screen. The floor of 1 ms keeps a
        // zero-ttl mint from being dead on arrival with no way to tell.
        let expires_at_ms = now_ms.saturating_add(ttl_ms.clamp(1, MAX_CAPABILITY_TTL_MS));
        self.live.insert(
            token,
            Capability {
                client,
                purpose,
                expires_at_ms,
            },
        );
        expires_at_ms
    }

    /// Spend a token. **Single use**: a successful redemption removes it, so a
    /// token read out of a child's environment cannot be replayed by a second
    /// child.
    pub fn spend(
        &mut self,
        token: &str,
        client: ClientKind,
        now_ms: u64,
    ) -> Result<Capability, RefusalCode> {
        self.expire(now_ms);
        let Some(found) = self.live.get(token) else {
            return Err(RefusalCode::TokenUnknown);
        };
        if found.client != client {
            // A token minted for the native host is not a token for the MCP
            // child: the purposes differ and so does what each may ask.
            return Err(RefusalCode::TokenUnknown);
        }
        Ok(self.live.remove(token).unwrap_or_else(|| unreachable!()))
    }

    /// Drop every token that has expired.
    pub fn expire(&mut self, now_ms: u64) {
        self.live.retain(|_, held| held.expires_at_ms > now_ms);
    }

    /// How many tokens are live. Test-only: nothing in the serving path counts
    /// them, and a `pub fn` a binary never calls is dead code.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.live.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.live.is_empty()
    }
}

/// Judge a `Hello` against this seat, with no I/O.
///
/// Split out so the refusal table is a table and not a chain of `if`s inside
/// the accept loop: every code in [`RefusalCode`] that a handshake can produce
/// is produced here, and the tests below name each one.
pub fn judge_hello(
    message: &ClientMessage,
    instance: &str,
    capabilities: &mut Capabilities,
    now_ms: u64,
) -> Result<ClientKind, RefusalCode> {
    let ClientMessage::Hello {
        client,
        nonce,
        token,
        protocol,
    } = message
    else {
        return Err(RefusalCode::HandshakeExpected);
    };
    if *protocol != LOCAL_PROTOCOL_VERSION {
        return Err(RefusalCode::ProtocolMismatch);
    }
    if client.proves_nonce() {
        let Some(offered) = nonce.as_deref() else {
            return Err(RefusalCode::NonceMissing);
        };
        // Constant-time is not the property that matters here — the peer is
        // already proven to be this uid, so the nonce is an INSTANCE binding
        // and not a secret. What matters is that a mismatch is refused rather
        // than adopted (census §F seam 4).
        if offered != instance {
            return Err(RefusalCode::ForeignInstance);
        }
        return Ok(*client);
    }
    let Some(offered) = token.as_deref() else {
        return Err(RefusalCode::TokenMissing);
    };
    capabilities
        .spend(offered, *client, now_ms)
        .map(|_| *client)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello(client: ClientKind, nonce: Option<&str>, token: Option<&str>) -> ClientMessage {
        ClientMessage::Hello {
            client,
            nonce: nonce.map(str::to_owned),
            token: token.map(str::to_owned),
            protocol: LOCAL_PROTOCOL_VERSION,
        }
    }

    #[test]
    fn an_empty_body_is_not_a_core_frame_with_an_empty_envelope() {
        assert_eq!(split_channel(&[]), None);
        assert_eq!(
            split_channel(&[CHANNEL_CORE]),
            Some((CHANNEL_CORE, &[][..]))
        );
        assert_eq!(
            split_channel(&[CHANNEL_LOCAL, b'{', b'}']),
            Some((CHANNEL_LOCAL, &b"{}"[..]))
        );
        assert_eq!(
            tagged(CHANNEL_LOCAL, b"{}"),
            vec![CHANNEL_LOCAL, b'{', b'}']
        );
    }

    #[test]
    fn the_renderer_proves_the_instance_nonce_and_a_stranger_is_refused() {
        let mut caps = Capabilities::new();
        assert_eq!(
            judge_hello(
                &hello(ClientKind::Renderer, Some("abc"), None),
                "abc",
                &mut caps,
                0
            ),
            Ok(ClientKind::Renderer)
        );
        // THE ADOPTION RULE, restated for a seat: another install's shell is
        // refused, never adopted.
        assert_eq!(
            judge_hello(
                &hello(ClientKind::Renderer, Some("other"), None),
                "abc",
                &mut caps,
                0
            ),
            Err(RefusalCode::ForeignInstance)
        );
        assert_eq!(
            judge_hello(
                &hello(ClientKind::Renderer, None, None),
                "abc",
                &mut caps,
                0
            ),
            Err(RefusalCode::NonceMissing)
        );
    }

    #[test]
    fn a_child_needs_a_token_this_seat_minted_and_it_is_single_use() {
        let mut caps = Capabilities::new();
        assert_eq!(
            judge_hello(&hello(ClientKind::Mcp, None, None), "abc", &mut caps, 0),
            Err(RefusalCode::TokenMissing)
        );
        assert_eq!(
            judge_hello(
                &hello(ClientKind::Mcp, None, Some("nope")),
                "abc",
                &mut caps,
                0
            ),
            Err(RefusalCode::TokenUnknown)
        );
        caps.mint(
            "tok".to_owned(),
            ClientKind::Mcp,
            "one turn".to_owned(),
            0,
            60_000,
        );
        assert_eq!(caps.len(), 1);
        assert_eq!(
            judge_hello(
                &hello(ClientKind::Mcp, None, Some("tok")),
                "abc",
                &mut caps,
                0
            ),
            Ok(ClientKind::Mcp)
        );
        // SPENT. A token read out of `/proc/<pid>/environ` by a second child of
        // this same uid buys nothing.
        assert!(caps.is_empty());
        assert_eq!(
            judge_hello(
                &hello(ClientKind::Mcp, None, Some("tok")),
                "abc",
                &mut caps,
                0
            ),
            Err(RefusalCode::TokenUnknown)
        );
    }

    #[test]
    fn a_token_minted_for_the_native_host_does_not_admit_the_mcp_child() {
        let mut caps = Capabilities::new();
        caps.mint(
            "tok".to_owned(),
            ClientKind::NativeHost,
            "a browser turn".to_owned(),
            0,
            60_000,
        );
        assert_eq!(
            judge_hello(
                &hello(ClientKind::Mcp, None, Some("tok")),
                "abc",
                &mut caps,
                0
            ),
            Err(RefusalCode::TokenUnknown)
        );
        // The token it WAS minted for still works, so the refusal above is
        // about the kind and not about the token being broken.
        assert_eq!(
            judge_hello(
                &hello(ClientKind::NativeHost, None, Some("tok")),
                "abc",
                &mut caps,
                0
            ),
            Ok(ClientKind::NativeHost)
        );
    }

    #[test]
    fn a_capability_expires_and_the_ttl_is_clamped_rather_than_refused() {
        let mut caps = Capabilities::new();
        let expires = caps.mint(
            "tok".to_owned(),
            ClientKind::Mcp,
            "turn".to_owned(),
            1_000,
            5_000,
        );
        assert_eq!(expires, 6_000);
        assert_eq!(
            judge_hello(
                &hello(ClientKind::Mcp, None, Some("tok")),
                "abc",
                &mut caps,
                6_001
            ),
            Err(RefusalCode::TokenUnknown)
        );
        // An hour asked for is ten minutes granted, with a token.
        let expires = caps.mint(
            "two".to_owned(),
            ClientKind::Mcp,
            "turn".to_owned(),
            0,
            3_600_000,
        );
        assert_eq!(expires, MAX_CAPABILITY_TTL_MS);
        // And a zero ttl is one millisecond, not a token that is dead on
        // arrival with no way for the caller to tell.
        assert_eq!(
            caps.mint("three".to_owned(), ClientKind::Mcp, "t".to_owned(), 7, 0),
            8
        );
    }

    #[test]
    fn a_build_mismatch_is_its_own_refusal_and_not_a_bad_nonce() {
        let mut caps = Capabilities::new();
        assert_eq!(
            judge_hello(
                &ClientMessage::Hello {
                    client: ClientKind::Renderer,
                    nonce: Some("abc".to_owned()),
                    token: None,
                    protocol: LOCAL_PROTOCOL_VERSION + 1,
                },
                "abc",
                &mut caps,
                0
            ),
            Err(RefusalCode::ProtocolMismatch)
        );
    }

    #[test]
    fn anything_that_is_not_a_hello_first_is_refused_as_such() {
        let mut caps = Capabilities::new();
        assert_eq!(
            judge_hello(&ClientMessage::DevicesList { id: 1 }, "abc", &mut caps, 0),
            Err(RefusalCode::HandshakeExpected)
        );
    }

    #[test]
    fn every_refusal_code_has_its_own_sentence() {
        let codes = [
            RefusalCode::ForeignPeer,
            RefusalCode::ProtocolMismatch,
            RefusalCode::ForeignInstance,
            RefusalCode::NonceMissing,
            RefusalCode::TokenMissing,
            RefusalCode::TokenUnknown,
            RefusalCode::TokenSpent,
            RefusalCode::HandshakeExpected,
            RefusalCode::Unsupported,
            RefusalCode::NotPermitted,
        ];
        let mut seen = std::collections::BTreeSet::new();
        for code in codes {
            assert!(!code.sentence().is_empty());
            assert!(seen.insert(code.sentence()), "{code:?} shares a sentence");
        }
        assert_eq!(seen.len(), codes.len());
    }

    #[test]
    fn only_the_shell_may_mint() {
        assert!(ClientKind::Renderer.may_mint());
        assert!(!ClientKind::Mcp.may_mint());
        assert!(!ClientKind::NativeHost.may_mint());
        assert!(ClientKind::Renderer.proves_nonce());
        assert!(!ClientKind::NativeHost.proves_nonce());
    }

    /// The JSON spelling is the contract the Electron main process reads, so it
    /// is pinned here rather than left to serde's defaults drifting under a
    /// rename.
    #[test]
    fn the_json_spelling_is_pinned() {
        let encoded = serde_json::to_string(&hello(ClientKind::NativeHost, None, Some("t")))
            .expect("a hello encodes");
        assert_eq!(
            encoded,
            r#"{"t":"hello","client":"native-host","token":"t","protocol":1}"#
        );
        let state = SeatMessage::State {
            id: Some(3),
            state: SeatStateJson {
                availability: Availability::Unavailable,
                durability: Durability::None,
                pending_work: PendingWork {
                    outbox: 0,
                    behind: 0,
                    stalled: false,
                },
                connectivity: Connectivity::Unconfigured,
                mode: SeatMode::Thin,
                at_ms: 5,
            },
        };
        let encoded = serde_json::to_string(&state).expect("a state encodes");
        assert!(
            encoded.contains(r#""availability":"unavailable""#),
            "{encoded}"
        );
        assert!(
            encoded.contains(r#""connectivity":"unconfigured""#),
            "{encoded}"
        );
        assert!(encoded.contains(r#""mode":"thin""#), "{encoded}");
        // And it round-trips, so the renderer and the seat read one shape.
        let back: SeatMessage = serde_json::from_str(&encoded).expect("state decodes");
        assert_eq!(back, state);
    }
}
