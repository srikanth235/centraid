//! THE RELAY: one Companion method, lowered to the seat's local channel
//! (#1020 wave 4 lane extension, D-1020-X2, D-1020-X6).
//!
//! The host answers almost nothing itself. What it does is decide, for each of
//! the eighteen methods, **which local-channel message it is** — and that
//! decision is [`lower`], a pure function with no socket in it, so the whole
//! table is tested without a seat.
//!
//! ## Four lowerings, and what each costs
//!
//! | Lowering | Methods | Why |
//! |---|---|---|
//! | [`Lowering::Here`] | `status`, `pair`, `select-vault`, `unpair`, `unlock`, `page:capture` | facts about this machine and this browser, or a refusal that is the whole answer |
//! | [`Lowering::Page`] | `warm`, `modules`, `blocking-count`, `locker:candidates` | a NAMED read from the sidecar's catalogue — the host never composes one |
//! | [`Lowering::Command`] | `locker:save`, `capture:*`, `agenda:add`, `people:add` | the vault's own write surface, by command name |
//! | [`Lowering::Fill`] | `locker:fill` | the one message that answers with a secret |
//!
//! ## Why `unlock` is a refusal and not a message
//!
//! `centraid native-host` may lock a seat and may never unlock one. *A door
//! that can raise the passphrase prompt is a door that can be used to phish it*
//! (`crates/seat/src/locker/mod.rs`), and a browser extension is the exact
//! caller that sentence is about. The seat enforces it too — `locker_unlock` is
//! renderer-only there — so this refusal is the host being honest early rather
//! than the boundary.
//!
//! ## Why `pair` stopped being a pairing
//!
//! v0's `pair` reads a QR ticket and enrols the browser with a gateway as a
//! DEVICE (`companion-api.ts:66`–`:118`). There is no such device now: the
//! extension is not a seat and can never become one (D-1020-X1), and what it
//! talks to is the one seat on this machine. So `pair` answers the seat's own
//! identity — this vault, this instance — and the enrolment it used to perform
//! is the host manifest's extension-id allowlist plus the member allowing the
//! browser in the shell. The method stays in the table because the extension's
//! first screen still asks it; what changed is that the answer is a fact rather
//! than a handshake.

use super::methods::Method;

/// How many rows a Companion read may pull.
///
/// 100 for the badge's four sources, because `approvalBadgeText` caps the badge
/// at 99 (`apps/extension/src/worker-core.ts:7`–`:10`) — a hundredth row is
/// already "99+", so a wider window would buy a number nobody renders.
pub const BADGE_ROWS: u32 = 100;

/// How many logins the candidate read pulls. v0's own ceiling
/// (`LOGIN_ROWS`, `crates/apps/locker::queries::LOGIN_ROWS`).
pub const CANDIDATE_ROWS: u32 = 2_000;

/// What the host does with one method.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lowering {
    /// Answered by the host, with no seat message at all.
    Here(HostAnswered),
    /// One or more named catalogue reads, folded into the method's answer.
    Page {
        statements: Vec<&'static str>,
        limit: u32,
    },
    /// One vault command.
    Command {
        name: String,
        input: serde_json::Value,
    },
    /// The seat-mediated fill.
    Fill {
        item_id: String,
        page_origin: String,
        column: String,
    },
}

/// What the host answers without asking the seat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostAnswered {
    /// This browser's view of the seat: attached, the host's version, the vault.
    Identity,
    /// Forget this browser's own state. Nothing on the seat changes.
    Forget,
    /// Close the Locker session and forget local state.
    LockOut,
    /// The content script answers this one; the host has no part in it.
    InThePage,
    /// A typed refusal that IS the answer.
    Refused {
        code: &'static str,
        message: &'static str,
    },
}

/// Why a method could not be lowered. Distinct from a refusal the host
/// *answers*: this is a malformed request.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LowerError {
    #[error("`{method}` needs `{field}`")]
    Missing {
        method: &'static str,
        field: &'static str,
    },
}

fn required<'a>(
    input: &'a serde_json::Value,
    method: Method,
    field: &'static str,
) -> Result<&'a str, LowerError> {
    input
        .get(field)
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or(LowerError::Missing {
            method: method.wire_name(),
            field,
        })
}

/// Lower one method and its input.
///
/// `input` is the frame's own object — v0's `CompanionRequest` minus its `type`
/// — and the field names are v0's, because `contracts/extension/methods.json`
/// carries them and the extension sends them.
pub fn lower(method: Method, input: &serde_json::Value) -> Result<Lowering, LowerError> {
    Ok(match method {
        Method::Status | Method::Pair | Method::SelectVault => {
            Lowering::Here(HostAnswered::Identity)
        }
        Method::Unpair => Lowering::Here(HostAnswered::Forget),
        // LOCKING IS NEVER AN ESCALATION, so the browser may ask; UNLOCKING is,
        // so it may not.
        Method::Lock => Lowering::Here(HostAnswered::LockOut),
        Method::Unlock => Lowering::Here(HostAnswered::Refused {
            code: "not-permitted",
            message: "Unlock Centraid itself — the browser never takes your passphrase.",
        }),
        // A CHEAP ROUND TRIP that proves the seat answers, and nothing more:
        // v0's `warm` is `GET /_vault/status` and exists to wake the link.
        Method::Warm => Lowering::Page {
            statements: vec!["tally.vault"],
            limit: 1,
        },
        Method::Modules => Lowering::Page {
            statements: vec!["companion.apps"],
            limit: BADGE_ROWS,
        },
        Method::BlockingCount => Lowering::Page {
            // v0's four sources, in v0's order
            // (`packages/server/src/serve/vault-plane.ts:1254`–`:1292`).
            statements: vec![
                "companion.outbox",
                "companion.connections",
                "companion.parked",
                "companion.scopeRequests",
            ],
            limit: BADGE_ROWS,
        },
        Method::LockerCandidates => Lowering::Page {
            statements: vec!["locker.autofillLogins"],
            limit: CANDIDATE_ROWS,
        },
        Method::LockerFill => Lowering::Fill {
            item_id: required(input, method, "itemId")?.to_owned(),
            // THE ORIGIN, DERIVED HERE, as v0 derives it (`new URL(pageUrl)
            // .origin`, `companion-api.ts:163`). The seat requires an exact
            // origin and re-derives it anyway, so this is a normalisation and
            // not a check: a page URL with a path would otherwise be refused as
            // malformed and read as a bug rather than as a caller's shape.
            page_origin: origin_of(required(input, method, "pageUrl")?).ok_or(
                LowerError::Missing {
                    method: method.wire_name(),
                    field: "pageUrl",
                },
            )?,
            // `password`, ALWAYS. The column is not a parameter of the frame:
            // an OTP seed is never filled into a page, the code is derived, and
            // a caller-chosen column is how the seed would leave the seat.
            column: "password".to_owned(),
        },
        Method::LockerSave => Lowering::Command {
            name: "locker.add_item".to_owned(),
            input: serde_json::json!({
                "type": "login",
                "title": input.get("title").cloned().unwrap_or_default(),
                "username": input.get("username").cloned().unwrap_or_else(|| serde_json::json!("")),
                "password": input.get("password").cloned().unwrap_or_default(),
                "url": required(input, method, "pageUrl")?,
                "url_match_policy": "registrable-domain",
            }),
        },
        Method::CaptureTask => Lowering::Command {
            name: "schedule.add_task".to_owned(),
            input: capture_input(input, "title", "description"),
        },
        Method::CaptureNote => Lowering::Command {
            name: "knowledge.create_note".to_owned(),
            input: capture_input(input, "title", "body_text"),
        },
        Method::CaptureDocument => Lowering::Command {
            name: "core.add_document".to_owned(),
            input: serde_json::json!({
                "title": capture_title(input),
                // THE HANDLE, not the bytes. `stage:end` answered this sha and
                // the command claims it; the claim itself is the byte door's
                // (`crates/apps/docs::bytes`, D-1020-X3).
                "staged_sha": input.get("staged_sha").cloned().unwrap_or_default(),
            }),
        },
        Method::AgendaAdd => Lowering::Command {
            name: "schedule.propose_event".to_owned(),
            input: serde_json::json!({
                "summary": required(input, method, "summary")?,
                "dtstart": required(input, method, "start")?,
                "dtend": required(input, method, "end")?,
                "calendar_id": required(input, method, "calendarId")?,
            }),
        },
        Method::PeopleAdd => Lowering::Command {
            name: "people.add_person".to_owned(),
            input: serde_json::json!({
                "display_name": required(input, method, "displayName")?,
                "cadence_days": input.get("cadenceDays").cloned().unwrap_or_default(),
                "role": input.get("role").cloned().unwrap_or(serde_json::Value::Null),
            }),
        },
        // v0 answers this in the browser (`companion-api.ts:318` returns
        // `undefined`): the content script reads the page. What the host adds is
        // the staging session the bytes travel in, which is a `stage:*` frame
        // and not this method.
        Method::PageCapture => Lowering::Here(HostAnswered::InThePage),
    })
}

/// A page URL's origin, `scheme://host[:port]`.
///
/// `None` for anything that is not an http(s) URL — which is the closed
/// direction, and the same one `crates/apps/locker::page_origin` takes for the
/// stricter question of whether a caller already sent an origin.
#[must_use]
pub fn origin_of(page_url: &str) -> Option<String> {
    let url = url::Url::parse(page_url).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

/// v0's capture fold: the selection if there is one, else the title, else the
/// URL — and the anchored text as the body (`capture.ts`, `companion-api.ts`).
fn capture_input(
    input: &serde_json::Value,
    title_field: &str,
    body_field: &str,
) -> serde_json::Value {
    let capture = input.get("capture").cloned().unwrap_or_default();
    let text = |key: &str| {
        capture
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let url = text("url").unwrap_or_default();
    let title = text("selection")
        .or_else(|| text("title"))
        .unwrap_or_else(|| url.clone());
    let body = match text("selection") {
        Some(selection) => format!("{selection}\n\n{url}"),
        None => url,
    };
    serde_json::json!({ title_field: title, body_field: body })
}

fn capture_title(input: &serde_json::Value) -> String {
    let capture = input.get("capture").cloned().unwrap_or_default();
    capture
        .get("title")
        .and_then(serde_json::Value::as_str)
        .filter(|title| !title.is_empty())
        .or_else(|| capture.get("url").and_then(serde_json::Value::as_str))
        .unwrap_or("Web capture")
        .to_owned()
}

/// The commands this host names that the vault does not register yet.
///
/// Named rather than discovered: `schedule.*` is slot 4d's schema and
/// `people.*` is the People lane's — and a host that silently mapped a capture
/// onto a command nobody registered would be a capture button that reports
/// success and writes nothing. The frames fixture marks these `pending`, and
/// [`tests::the_pending_commands_are_the_ones_the_registry_lacks`] fails when
/// one of them lands — which is the point: the list shrinks by being wrong.
///
/// It has shrunk once already. `knowledge.create_note` came off when the Notes
/// lane registered the `knowledge` schema in this same wave, and the test above
/// is what said so: `capture:note` lowers to `{title, body_text}`, which is
/// exactly what `CREATE_NOTE_SCHEMA` requires, so the button now writes a note
/// instead of answering "this capture needs a newer Centraid".
pub const PENDING_COMMANDS: [&str; 3] = [
    "schedule.add_task",
    "schedule.propose_event",
    "people.add_person",
];

/// THE SOCKET HALF: one seat connection for the life of the browser port.
///
/// ## Why one connection and not one per request
///
/// Lane F's Companion opened a **native port per request** and said why: *a
/// native port holds a process, and a background page that kept one open would
/// keep `centraid native-host` — and through it a capability token — alive for
/// the life of the browser* (`extension/README.md`). Two things changed that
/// (D-1020-X4, D-1020-X7):
///
/// 1. the capability token the seat mints is **single-use**
///    (`crates/centraid/src/cmd/seat/local.rs`, D-1020-F14), so one token per
///    request means the shell minting a token per keystroke;
/// 2. the badge is better pushed than polled, and a push needs a port that is
///    open when the seat has something to say.
///
/// So the port is long-lived and the **lifetime is bounded by use instead**: the
/// extension opens it on first use and closes it after an idle timeout, and this
/// process exits when the port closes. The property lane F wanted — no
/// unattended host holding a token — is kept by the idle close rather than by
/// the per-request open, and it is the extension's `worker.ts` that owns it.
pub struct SeatClient {
    stream: std::os::unix::net::UnixStream,
    next_id: u64,
    /// What the handshake answered, for `status` and `pair`.
    pub hello: serde_json::Value,
}

impl SeatClient {
    /// Connect, handshake as `native-host`, and hold the link.
    ///
    /// **Blocking sockets, no runtime.** This process's whole shape is
    /// read-a-frame / answer-a-frame on stdin and stdout, and `centraid`'s
    /// `main` is already inside a tokio runtime — so a second runtime here
    /// panics, and an async relay would mean carrying an executor for one
    /// request at a time. The seat's framing is `u32BE(len) ‖ channel-tagged
    /// body` either way; only the I/O differs.
    ///
    /// The token is presented and never logged; a refused handshake carries the
    /// seat's own `RefusalCode` through, because the extension renders one
    /// sentence per code and inventing a generic one here would lose that.
    pub fn attach(socket: &std::path::Path, token: &str) -> Result<Self, String> {
        let mut stream = std::os::unix::net::UnixStream::connect(socket)
            .map_err(|error| format!("the seat socket would not open: {error}"))?;
        // A CEILING ON THE WAIT, so a seat that accepted the connection and then
        // stopped answering shows up as a refusal rather than as a browser
        // spinner nobody can cancel.
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));
        let hello = serde_json::json!({
            "t": "hello",
            "client": "native-host",
            "token": token,
            "protocol": crate::cmd::seat::local::LOCAL_PROTOCOL_VERSION,
        });
        send(&mut stream, &hello)?;
        let answer = recv(&mut stream)?;
        if answer.get("t").and_then(serde_json::Value::as_str) != Some("hello_ok") {
            return Err(answer
                .get("code")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("refused")
                .to_owned());
        }
        Ok(Self {
            stream,
            next_id: 0,
            hello: answer,
        })
    }

    fn mint(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    /// One request/response turn on the local channel.
    pub fn ask(&mut self, mut message: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = self.mint();
        if let Some(object) = message.as_object_mut() {
            object.insert("id".to_owned(), serde_json::json!(id));
        }
        send(&mut self.stream, &message)?;
        // The seat answers one message per request on this channel; a `state`
        // push that arrived first is SKIPPED rather than mistaken for the
        // answer, which is what makes the badge push safe to add (D-1020-X4).
        loop {
            let reply = recv(&mut self.stream)?;
            let kind = reply.get("t").and_then(serde_json::Value::as_str);
            let answered = reply.get("id").and_then(serde_json::Value::as_u64);
            if answered == Some(id) || kind == Some("refused") {
                return Ok(reply);
            }
        }
    }
}

fn send(
    stream: &mut std::os::unix::net::UnixStream,
    message: &serde_json::Value,
) -> Result<(), String> {
    use std::io::Write as _;
    let payload = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    let body = crate::cmd::seat::local::tagged(crate::cmd::seat::local::CHANNEL_LOCAL, &payload);
    let framed =
        centraid_protocol::framing::frame_bytes(&body).map_err(|error| error.to_string())?;
    stream
        .write_all(&framed)
        .map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())
}

fn recv(stream: &mut std::os::unix::net::UnixStream) -> Result<serde_json::Value, String> {
    use std::io::Read as _;
    let mut length = [0_u8; 4];
    stream
        .read_exact(&mut length)
        .map_err(|error| format!("the seat closed the link: {error}"))?;
    // `u32BE` — the PRODUCT's framing, and the one place in this file where the
    // difference from the browser's native-endian length matters.
    let length = u32::from_be_bytes(length) as usize;
    if length > centraid_protocol::framing::MAX_FRAME_BYTES {
        return Err(format!(
            "the seat sent a {length}-byte frame, over the protocol's ceiling"
        ));
    }
    let mut body = vec![0_u8; length];
    stream
        .read_exact(&mut body)
        .map_err(|error| format!("the seat closed the link: {error}"))?;
    let (channel, payload) = crate::cmd::seat::local::split_channel(&body)
        .ok_or_else(|| "a frame with no channel tag".to_owned())?;
    if channel != crate::cmd::seat::local::CHANNEL_LOCAL {
        return Err(format!("a reply on channel {channel}, not the local one"));
    }
    serde_json::from_slice(payload).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(value: serde_json::Value) -> serde_json::Value {
        value
    }

    /// EVERY METHOD LOWERS. A method in the table with no lowering would be a
    /// method the host accepts and never answers.
    #[test]
    fn every_method_in_the_table_has_a_lowering() {
        for method in super::super::methods::ALL {
            // The inputs each method needs, so `Missing` is not what is being
            // tested here.
            let stub = input(serde_json::json!({
                "itemId": "item-1",
                "pageUrl": "https://www.bank.example",
                "summary": "s",
                "start": "2026-01-01T09:00:00Z",
                "end": "2026-01-01T10:00:00Z",
                "calendarId": "cal-1",
                "displayName": "A Person",
                "title": "t",
                "password": "p",
                "capture": { "title": "t", "url": "https://example.test" },
            }));
            assert!(
                lower(method, &stub).is_ok(),
                "{} has no lowering",
                method.wire_name()
            );
        }
    }

    /// THE BROWSER MAY LOCK AND MAY NOT UNLOCK.
    #[test]
    fn unlock_is_refused_here_and_lock_is_not() {
        assert_eq!(
            lower(Method::Lock, &serde_json::json!({})).expect("lowered"),
            Lowering::Here(HostAnswered::LockOut)
        );
        let Lowering::Here(HostAnswered::Refused { code, message }) =
            lower(Method::Unlock, &serde_json::json!({})).expect("lowered")
        else {
            panic!("unlock is refused by the host");
        };
        assert_eq!(code, "not-permitted");
        assert!(message.contains("passphrase"), "{message}");
    }

    /// THE FILL'S COLUMN IS NOT A PARAMETER. A frame that names one is ignored.
    #[test]
    fn a_fill_always_asks_for_the_password_and_never_the_seed() {
        let asked = lower(
            Method::LockerFill,
            &serde_json::json!({
                "itemId": "item-1",
                "pageUrl": "https://www.bank.example",
                "column": "otp_seed",
            }),
        )
        .expect("lowered");
        assert_eq!(
            asked,
            Lowering::Fill {
                item_id: "item-1".to_owned(),
                page_origin: "https://www.bank.example".to_owned(),
                column: "password".to_owned(),
            }
        );
    }

    /// THE ORIGIN IS DERIVED FROM THE PAGE URL, as v0 derives it.
    #[test]
    fn a_page_url_with_a_path_still_yields_its_origin() {
        let Lowering::Fill { page_origin, .. } = lower(
            Method::LockerFill,
            &serde_json::json!({
                "itemId": "item-1",
                "pageUrl": "https://www.bank.example/sign-in?next=/home",
            }),
        )
        .expect("lowered") else {
            panic!("a fill");
        };
        assert_eq!(page_origin, "https://www.bank.example");
        // A default port is not spelled out, and a non-default one is.
        assert_eq!(
            origin_of("https://www.bank.example:443/x").as_deref(),
            Some("https://www.bank.example")
        );
        assert_eq!(
            origin_of("https://www.bank.example:8443/x").as_deref(),
            Some("https://www.bank.example:8443")
        );
        for bad in ["file:///etc/passwd", "about:blank", "", "bank.example"] {
            assert!(origin_of(bad).is_none(), "{bad:?}");
        }
    }

    /// A MISSING FIELD IS NAMED, with the method that wanted it.
    #[test]
    fn a_missing_field_names_itself() {
        assert_eq!(
            lower(Method::LockerFill, &serde_json::json!({ "itemId": "i" })),
            Err(LowerError::Missing {
                method: "locker:fill",
                field: "pageUrl"
            })
        );
        assert_eq!(
            lower(Method::AgendaAdd, &serde_json::json!({ "summary": "s" })),
            Err(LowerError::Missing {
                method: "agenda:add",
                field: "start"
            })
        );
    }

    /// v0's CAPTURE FOLD, carried: a selection wins, then the title, then the
    /// URL — and the body anchors the text to the page it came from.
    #[test]
    fn a_capture_takes_the_selection_then_the_title_then_the_url() {
        let Lowering::Command { input: task, .. } = lower(
            Method::CaptureTask,
            &serde_json::json!({
                "capture": {
                    "title": "A Page",
                    "url": "https://example.test/a",
                    "selection": "  the selected sentence  ",
                }
            }),
        )
        .expect("lowered") else {
            panic!("a capture is a command");
        };
        assert_eq!(task["title"], "the selected sentence");
        assert_eq!(
            task["description"],
            "the selected sentence\n\nhttps://example.test/a"
        );
        let Lowering::Command { input: note, .. } = lower(
            Method::CaptureNote,
            &serde_json::json!({ "capture": { "url": "https://example.test/b" } }),
        )
        .expect("lowered") else {
            panic!("a capture is a command");
        };
        assert_eq!(note["title"], "https://example.test/b");
    }

    /// THE BADGE WINDOW IS THE BADGE'S CAP. A wider read would answer a number
    /// nothing renders.
    #[test]
    fn the_badge_reads_four_sources_within_the_badges_own_cap() {
        let Lowering::Page { statements, limit } =
            lower(Method::BlockingCount, &serde_json::json!({})).expect("lowered")
        else {
            panic!("the badge is a read");
        };
        assert_eq!(
            statements,
            [
                "companion.outbox",
                "companion.connections",
                "companion.parked",
                "companion.scopeRequests"
            ]
        );
        assert_eq!(limit, BADGE_ROWS);
        assert_eq!(BADGE_ROWS, 100, "one past the badge's 99 cap");
    }

    /// EVERY NAMED READ IS IN THE SIDECAR'S CATALOGUE. A statement the host
    /// names and the seat does not serve is a method that always fails.
    #[test]
    fn every_named_read_is_a_statement_the_seat_serves() {
        let served: Vec<&str> = crate::cmd::seat::catalogue::catalogue()
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        for method in super::super::methods::ALL {
            let stub = serde_json::json!({
                "itemId": "i", "pageUrl": "https://a.test", "summary": "s",
                "start": "x", "end": "y", "calendarId": "c", "displayName": "d",
                "password": "p", "title": "t",
            });
            if let Ok(Lowering::Page { statements, .. }) = lower(method, &stub) {
                for statement in statements {
                    assert!(
                        served.contains(&statement),
                        "`{statement}` is named by {} and is not in the catalogue",
                        method.wire_name()
                    );
                }
            }
        }
    }

    /// THE PENDING LIST SHRINKS BY BEING WRONG (the automations lane's pattern).
    ///
    /// Every command this host names is either registered in the vault or on
    /// [`PENDING_COMMANDS`]; when a lane lands one, this test fails and the name
    /// comes off the list rather than staying a silent no-op.
    #[test]
    fn the_pending_commands_are_the_ones_the_registry_lacks() {
        let registry = centraid_vault::commands::Registry::with_system_commands()
            .expect("the vault's own registry");
        let registered = registry.names();
        for method in super::super::methods::ALL {
            let stub = serde_json::json!({
                "itemId": "i", "pageUrl": "https://a.test", "summary": "s",
                "start": "x", "end": "y", "calendarId": "c", "displayName": "d",
                "password": "p", "title": "t",
            });
            if let Ok(Lowering::Command { name, .. }) = lower(method, &stub) {
                let known = registered.contains(&name.as_str());
                let pending = PENDING_COMMANDS.contains(&name.as_str());
                assert!(
                    known != pending,
                    "`{name}` is {}registered and {}on the pending list",
                    if known { "" } else { "not " },
                    if pending { "" } else { "not " }
                );
            }
        }
    }
}
