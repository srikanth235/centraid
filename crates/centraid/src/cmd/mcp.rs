//! `centraid mcp` — the vault tool surface as a harness's MCP child (#1020,
//! D-1020-AS2).
//!
//! ## No listener, and the framing that replaces one
//!
//! v0 served these tools over a loopback HTTP MCP server on an ephemeral port
//! (`backends/acp/vault-mcp-server.ts`). This verb serves the same three tools
//! and the same five methods over **stdin and stdout**, so there is no port,
//! nothing binds, and `no-listening-socket` stays clean over `crates/centraid`.
//!
//! The wire is MCP's own stdio framing — **newline-delimited JSON**, one
//! JSON-RPC message per line — and it is a third framing in this binary, which
//! is worth saying out loud because getting them confused is the whole class of
//! bug here:
//!
//! | Surface | Framing |
//! |---|---|
//! | the seat socket | `u32BE(len) ‖ channel-tagged body` (`crates/protocol`) |
//! | `centraid native-host` | `u32<native-endian>(len) ‖ JSON` (Chrome's) |
//! | `centraid mcp` (this) | one JSON object per line |
//!
//! ## Nothing is printed to stdout that is not a message
//!
//! stdout *is* the protocol. A progress line, a warning or a stray `println!`
//! desynchronises the harness's parser and the turn fails with something
//! unrelated. Every diagnostic goes to stderr, which the harness shows the
//! member.
//!
//! ## The credential
//!
//! Two environment variables, set by the shell when it puts this command in the
//! `mcpServers` entry of `session/new`: `CENTRAID_SEAT_SOCKET` and
//! `CENTRAID_TURN_TOKEN`. The token is single-use and expires, and the seat
//! also checks the peer's uid — so a token that leaked to another account on
//! the machine still does not work
//! (`crates/centraid/src/cmd/seat/local.rs`, `ClientKind::Mcp`).
//!
//! Without them the process **refuses to start** rather than falling back to
//! opening the vault file itself. That fallback is the tempting one and it is
//! exactly wrong: a child that opened the file would be a second writer of the
//! one vault and a second gateway.

use std::io::{BufRead, Write};

use centraid_assist::mcp::{self, SeatDoor, Server};
use centraid_vault::ledger::sql_guard::Caller;

use crate::exit;

/// Serve MCP on stdin and stdout until the stream closes.
pub fn run() -> u8 {
    let env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
    let door = match mcp::SocketDoor::from_env(&env, caller_for(&env)) {
        Ok(door) => door,
        Err(error) => {
            eprintln!("centraid mcp: {error}");
            return exit::REFUSED;
        }
    };
    let server = Server::new(door, env!("CARGO_PKG_VERSION"));
    serve(&server, std::io::stdin().lock(), std::io::stdout().lock())
}

/// Which principal this turn runs as.
///
/// The token names the turn, and the turn's principal is the seat's to decide —
/// this process cannot promote itself by reading its own environment. Until the
/// local channel carries the answer, an unattended turn is **scoped**, which is
/// the closed direction: `vault_sql` is refused and the member sees why, rather
/// than a child process granting itself the owner's whole-model surface.
fn caller_for(env: &std::collections::BTreeMap<String, String>) -> Caller {
    if env.get("CENTRAID_TURN_SURFACE").map(String::as_str) == Some("owner-interactive") {
        Caller::Owner
    } else {
        Caller::Scoped {
            name: "assistant turn",
        }
    }
}

/// The read-dispatch-write loop, over any streams. Separated so a test can
/// drive it with pipes rather than with this process's own stdio.
pub fn serve<D: SeatDoor>(server: &Server<D>, input: impl BufRead, mut output: impl Write) -> u8 {
    for line in input.lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("centraid mcp: reading stdin: {error}");
                return exit::REFUSED;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let request: serde_json::Value = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                // A malformed line is reported on stderr and skipped. It is NOT
                // answered with a JSON-RPC error, because a message that did not
                // parse has no id to answer, and inventing one is how a client
                // ends up matching a response to the wrong request.
                eprintln!("centraid mcp: not a JSON-RPC message: {error}");
                continue;
            }
        };
        let Some(answer) = server.handle(&request) else {
            continue;
        };
        let encoded = match serde_json::to_string(&answer) {
            Ok(encoded) => encoded,
            Err(error) => {
                eprintln!("centraid mcp: could not encode a response: {error}");
                continue;
            }
        };
        if writeln!(output, "{encoded}").is_err() || output.flush().is_err() {
            // The harness closed its end: the turn is over, and that is an
            // ordinary ending rather than a failure.
            return exit::OK;
        }
    }
    exit::OK
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_assist::mcp::{DoorError, Rows};
    use centraid_vault::ledger::sql_guard;

    struct Stub;

    impl SeatDoor for Stub {
        fn caller(&self) -> Caller {
            Caller::Owner
        }
        fn query(&self, _checked: &sql_guard::Checked, _max: usize) -> Result<Rows, DoorError> {
            Ok(Rows {
                columns: vec!["n".to_owned()],
                rows: vec![vec![serde_json::json!(1)]],
                truncated: false,
            })
        }
        fn attachment(&self, _hash: &str) -> Result<Option<(String, String)>, DoorError> {
            Ok(None)
        }
    }

    fn transcript(input: &str) -> Vec<serde_json::Value> {
        let server = Server::new(Stub, "test");
        let mut out = Vec::new();
        assert_eq!(serve(&server, input.as_bytes(), &mut out), exit::OK);
        String::from_utf8(out)
            .expect("utf8")
            .lines()
            .map(|line| serde_json::from_str(line).expect("a JSON-RPC line"))
            .collect()
    }

    #[test]
    fn one_message_per_line_in_and_out() {
        let answers = transcript(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n\
             {\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n\
             {\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n",
        );
        assert_eq!(
            answers.len(),
            2,
            "the notification gets no line of its own on the way back"
        );
        assert_eq!(answers[0]["id"], 1);
        assert_eq!(answers[1]["id"], 2);
        assert_eq!(
            answers[1]["result"]["tools"].as_array().map(Vec::len),
            Some(3)
        );
    }

    #[test]
    fn a_malformed_line_is_skipped_rather_than_answered() {
        let answers = transcript("not json\n{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"ping\"}\n");
        assert_eq!(answers.len(), 1, "a line with no id has no answer to give");
        assert_eq!(answers[0]["id"], 7);
    }

    #[test]
    fn a_blank_line_is_not_a_message() {
        assert!(transcript("\n\n").is_empty());
    }

    #[test]
    fn a_turn_that_does_not_declare_the_owner_surface_is_scoped() {
        // The closed direction: a child process must not promote itself.
        let env = std::collections::BTreeMap::new();
        assert!(matches!(caller_for(&env), Caller::Scoped { .. }));
        let env = std::collections::BTreeMap::from([(
            "CENTRAID_TURN_SURFACE".to_owned(),
            "owner-interactive".to_owned(),
        )]);
        assert_eq!(caller_for(&env), Caller::Owner);
    }
}
