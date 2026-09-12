//! `centraid mcp` as a real child process, over real pipes (#1020,
//! D-1020-AS2).
//!
//! The unit tests drive the loop with byte slices; this one spawns the actual
//! binary the way a harness does — `{command: <path to centraid>, args:
//! ["mcp"], env: {...}}` — and reads its answers off its stdout. That is the
//! part the unit tests cannot prove: that the shipped verb speaks the protocol
//! when it is launched rather than called.
//!
//! It also proves the negative that the whole ruling is about: **nothing binds
//! a port.** The child's own view of its sockets is checked while it is
//! running, so the claim is about this process at this moment rather than about
//! a grep over the source.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

/// The binary under test. Cargo sets this for an integration test of a crate
/// that has a `[[bin]]`, so the test cannot drift from the artifact.
const CENTRAID: &str = env!("CARGO_BIN_EXE_centraid");

struct Harness {
    child: Child,
    reader: BufReader<std::process::ChildStdout>,
}

impl Harness {
    /// Launch `centraid mcp` with the two environment variables the shell sets
    /// when it puts this command in a `session/new` payload.
    fn launch() -> Self {
        let mut child = Command::new(CENTRAID)
            .arg("mcp")
            .env("CENTRAID_SEAT_SOCKET", "/run/centraid-test.sock")
            .env("CENTRAID_TURN_TOKEN", "per-turn-capability-token")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("centraid mcp launches");
        let stdout = child.stdout.take().expect("piped");
        Self {
            child,
            reader: BufReader::new(stdout),
        }
    }

    /// Send one JSON-RPC line and read the answer line.
    fn call(&mut self, request: &serde_json::Value) -> serde_json::Value {
        let stdin = self.child.stdin.as_mut().expect("piped");
        writeln!(stdin, "{request}").expect("write a request");
        stdin.flush().expect("flush");
        let mut line = String::new();
        self.reader.read_line(&mut line).expect("read an answer");
        serde_json::from_str(&line).unwrap_or_else(|error| {
            panic!("not a JSON-RPC answer: {error}: {line:?}");
        })
    }

    /// Send a notification, which by JSON-RPC's rules gets no answer.
    fn notify(&mut self, request: &serde_json::Value) {
        let stdin = self.child.stdin.as_mut().expect("piped");
        writeln!(stdin, "{request}").expect("write a notification");
        stdin.flush().expect("flush");
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn finish(mut self) {
        drop(self.child.stdin.take());
        let status = self
            .child
            .wait()
            .expect("the child exits when stdin closes");
        assert!(
            status.success(),
            "a closed stdin is an ordinary ending, not a failure: {status:?}"
        );
    }
}

#[test]
fn the_shipped_verb_serves_the_three_tools_and_refuses_a_scoped_statement() {
    let mut harness = Harness::launch();

    let initialize = harness.call(&serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": "2025-06-18" }
    }));
    assert_eq!(initialize["result"]["serverInfo"]["name"], "centraid");

    // A notification gets no line back. Sent between two requests on purpose:
    // if the server answered it, the NEXT `call` would read that answer and see
    // the wrong id — which is exactly the desynchronisation the rule prevents.
    harness.notify(&serde_json::json!({
        "jsonrpc": "2.0", "method": "notifications/initialized"
    }));

    let tools = harness.call(&serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/list"
    }));
    assert_eq!(tools["id"], 2, "the notification did not consume an id");
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .expect("an array")
        .iter()
        .map(|tool| tool["name"].as_str().expect("a name"))
        .collect();
    assert_eq!(names, ["vault_sql", "attachments_list", "attachments_read"]);

    let call = harness.call(&serde_json::json!({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": { "name": "vault_sql", "arguments": { "sql": "select display_name from core_party" } }
    }));
    assert!(
        call.get("error").is_none(),
        "a refusal is a tool result the model can read, not a transport fault"
    );
    assert_eq!(call["result"]["isError"], true);
    let message = call["result"]["content"][0]["text"]
        .as_str()
        .expect("a sentence");
    assert!(
        message.contains("owner"),
        "the refusal says what the boundary is: {message}"
    );

    harness.finish();
}

#[test]
fn the_child_refuses_to_start_without_its_capability_token() {
    // The tempting fallback — open the vault file directly — is exactly the one
    // that would make this child a second gateway. It must refuse instead.
    let output = Command::new(CENTRAID)
        .arg("mcp")
        .env_remove("CENTRAID_SEAT_SOCKET")
        .env_remove("CENTRAID_TURN_TOKEN")
        .stdin(Stdio::null())
        .output()
        .expect("centraid mcp runs");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("CENTRAID_SEAT_SOCKET"),
        "the refusal names what is missing: {stderr}"
    );
    assert!(
        output.stdout.is_empty(),
        "stdout IS the protocol: a diagnostic there desynchronises the harness"
    );
}

#[test]
#[cfg_attr(
    not(target_os = "linux"),
    ignore = "reads /proc/<pid>/net/tcp; the rule's static scan covers other hosts"
)]
fn the_running_child_holds_no_listening_socket() {
    let mut harness = Harness::launch();
    // Speak to it first, so the assertion is about a child that is *serving*
    // rather than one that has not started yet.
    let _ = harness.call(&serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "ping"
    }));

    let pid = harness.pid();
    let listening = listening_sockets(pid);
    assert!(
        listening.is_empty(),
        "`centraid mcp` is serving MCP over stdio and must hold no listening socket; found \
         {listening:?}. v0 served these same three tools over a loopback HTTP port, and this is \
         the ruling that replaced it (D-1020-AS2)."
    );
    harness.finish();
}

/// Local addresses this process has in `LISTEN` state, from its own `/proc`.
///
/// `/proc/<pid>/net/tcp` is the network namespace's table as this process sees
/// it, which is the honest question: a socket the child opened is in there, and
/// one another process on the host opened is not attributable to it — so the
/// inode column is matched against the child's own open file descriptors.
fn listening_sockets(pid: u32) -> Vec<String> {
    let mut inodes = std::collections::BTreeSet::new();
    if let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) {
        for entry in entries.flatten() {
            if let Ok(target) = std::fs::read_link(entry.path())
                && let Some(inode) = target
                    .to_string_lossy()
                    .strip_prefix("socket:[")
                    .and_then(|rest| rest.strip_suffix(']'))
            {
                inodes.insert(inode.to_owned());
            }
        }
    }
    let mut found = Vec::new();
    for table in ["tcp", "tcp6"] {
        let Ok(text) = std::fs::read_to_string(format!("/proc/{pid}/net/{table}")) else {
            continue;
        };
        for line in text.lines().skip(1) {
            let columns: Vec<&str> = line.split_whitespace().collect();
            // `local_address` is column 1, `st` column 3, `inode` column 9.
            // `0A` is TCP_LISTEN.
            if columns.len() > 9 && columns[3] == "0A" && inodes.contains(columns[9]) {
                found.push(format!("{table} {}", columns[1]));
            }
        }
    }
    found
}
