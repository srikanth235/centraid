//! `centraid mcp`: the vault tool surface over **stdio**, with no listener
//! (#1020, D-1020-AS2).
//!
//! ## The listener v0 had, and why it is gone
//!
//! `backends/acp/vault-mcp-server.ts` is a loopback MCP server over HTTP. Its
//! security posture was careful — 127.0.0.1 on an ephemeral port, a per-turn
//! 256-bit bearer compared in constant time, sockets closed in the turn's
//! `finally` so no port outlives the turn that opened it, including on abort —
//! and it existed for a real reason: ACP's `type: "acp"` MCP transport is
//! experimental and **neither first-party adapter implements it**, while both
//! advertise HTTP MCP. That made vault tools generic across kinds instead of
//! per-kind.
//!
//! It is still a listening socket in a product whose invariant is that there
//! are none (#1020: *no crate opens a listening TCP socket unless `blob-door`
//! is on*), and `crates/centraid`'s `no_listener` scan would see it.
//!
//! So: **stdio**. An MCP server is a JSON-RPC peer over a byte stream, and MCP
//! stdio servers are the ordinary case — every harness already knows how to
//! launch one. The `mcpServers` entry of `session/new` carries
//! `{command: <path to centraid>, args: ["mcp"], env: {...}}`; the harness
//! spawns it as its own child; the child speaks the same five methods v0 did
//! over its own stdin and stdout. Nothing binds, nothing listens, and the
//! tools stay generic across kinds because stdio MCP is better supported than
//! HTTP MCP, not worse.
//!
//! The per-turn secret survives the move and gets *better*: instead of a bearer
//! token in a header, the child is handed a capability token in its environment
//! and presents it to the seat socket, which also checks the peer's uid
//! (`crates/centraid/src/cmd/seat/local.rs`, `ClientKind::Mcp`). A token that
//! leaked to another user account on the machine still does not work.
//!
//! `unstable_mcp_over_acp` in `agent-client-protocol` 2.1.0 is the future
//! collapse of this whole module into the ACP connection itself. It is recorded
//! and **not enabled**: it is unstable, and the adapters do not implement the
//! transport it needs.
//!
//! ## The door, and why it is a trait
//!
//! [`SeatDoor`] is how a tool call reaches the vault. There are two
//! implementations and the distinction is not cosmetic:
//!
//! - [`SocketDoor`] — lane F's seat socket. What ships: the gateway holds the
//!   one writable connection, and a child process that opened the vault file
//!   itself would be a second gateway.
//! - [`HandleDoor`] — an in-process vault. What tests and the single-process
//!   case use.
//!
//! ## `vault_sql` and the free-form-statement gap
//!
//! The local channel carries `Page` (a **named** statement from a catalogue the
//! sidecar ships) and `Command`, deliberately: *a renderer cannot compose a
//! read the seat did not ship*. `vault_sql` is the exception the member's own
//! whole-model question needs, and no local message carries one today. The
//! grammar and the row cap are implemented here over
//! [`centraid_vault::ledger::sql_guard`] — that is where the security lives —
//! and the socket transport for it is an owner hand-off to lane F's successor,
//! recorded in the receipt. Until it lands, `vault_sql` is served by
//! [`HandleDoor`] and [`SocketDoor`] answers it as unavailable, which is an
//! honest absence rather than a second door.

use centraid_vault::ledger::sql_guard::{self, Caller, Refusal};

/// The MCP protocol version this server speaks.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// The server's own name, as it appears in a harness's tool list.
pub const SERVER_NAME: &str = "centraid";

/// The environment variable carrying the per-turn capability token.
pub const TURN_TOKEN_ENV: &str = "CENTRAID_TURN_TOKEN";

/// The environment variable carrying the seat socket's path.
pub const SEAT_SOCKET_ENV: &str = "CENTRAID_SEAT_SOCKET";

/// One row of a `vault_sql` answer: column names once, values per row.
#[derive(Debug, Clone, PartialEq)]
pub struct Rows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// Whether the cap truncated the answer. Reported, because a silently
    /// truncated answer is a wrong answer.
    pub truncated: bool,
}

/// Why a door could not answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DoorError {
    #[error("{0}")]
    Refused(#[from] Refusal),
    #[error("this door cannot serve {what}: {because}")]
    Unavailable {
        what: &'static str,
        because: &'static str,
    },
    #[error("{0}")]
    Transport(String),
}

/// How a tool call reaches the vault.
pub trait SeatDoor {
    /// Which principal this turn runs as. Decides `vault_sql` outright.
    fn caller(&self) -> Caller;

    /// Run one checked read-only statement.
    fn query(&self, checked: &sql_guard::Checked, max_rows: usize) -> Result<Rows, DoorError>;

    /// One attachment's bytes, by hash, base64.
    fn attachment(&self, hash: &str) -> Result<Option<(String, String)>, DoorError>;
}

/// The three tools, exactly v0's surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    /// One read-only statement over the whole model. Owner only.
    VaultSql,
    /// List the attachments visible to this turn.
    AttachmentsList,
    /// Read one attachment's bytes.
    AttachmentsRead,
}

impl Tool {
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::VaultSql => "vault_sql",
            Self::AttachmentsList => "attachments_list",
            Self::AttachmentsRead => "attachments_read",
        }
    }

    /// Every tool, in the order `tools/list` reports them.
    #[must_use]
    pub const fn all() -> [Self; 3] {
        [Self::VaultSql, Self::AttachmentsList, Self::AttachmentsRead]
    }

    /// The JSON Schema a harness needs to call it.
    #[must_use]
    pub fn input_schema(self) -> serde_json::Value {
        match self {
            Self::VaultSql => serde_json::json!({
                "type": "object",
                "properties": {
                    "sql": {
                        "type": "string",
                        "description":
                            "One read-only statement: a select, a with … select, or an explain."
                    }
                },
                "required": ["sql"],
                "additionalProperties": false
            }),
            Self::AttachmentsList => serde_json::json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
            Self::AttachmentsRead => serde_json::json!({
                "type": "object",
                "properties": { "hash": { "type": "string" } },
                "required": ["hash"],
                "additionalProperties": false
            }),
        }
    }

    #[must_use]
    pub const fn description(self) -> &'static str {
        match self {
            Self::VaultSql => {
                "Ask one read-only question of the whole vault. The owner's surface: an \
                 agent-scoped turn is refused."
            }
            Self::AttachmentsList => "The attachments this turn may read.",
            Self::AttachmentsRead => "One attachment's bytes, base64.",
        }
    }

    #[must_use]
    pub fn from_name(name: &str) -> Option<Self> {
        Self::all().into_iter().find(|tool| tool.name() == name)
    }
}

/// The five methods, and nothing else.
///
/// `initialize`, `notifications/initialized`, `ping`, `tools/list`,
/// `tools/call`. **Stateless, no session id** — v0's server was too, and it is
/// the right shape: the session is the ACP turn that spawned this process, and
/// a second notion of session inside it would be a second thing to expire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Initialize,
    Initialized,
    Ping,
    ToolsList,
    ToolsCall,
}

impl Method {
    #[must_use]
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "initialize" => Some(Self::Initialize),
            "notifications/initialized" => Some(Self::Initialized),
            "ping" => Some(Self::Ping),
            "tools/list" => Some(Self::ToolsList),
            "tools/call" => Some(Self::ToolsCall),
            _ => None,
        }
    }
}

/// JSON-RPC's method-not-found.
pub const METHOD_NOT_FOUND: i64 = -32_601;
/// JSON-RPC's invalid-params.
pub const INVALID_PARAMS: i64 = -32_602;

/// The server. Holds a door and nothing else — no socket, no port, no state.
pub struct Server<D: SeatDoor> {
    door: D,
    product_version: String,
}

impl<D: SeatDoor> Server<D> {
    pub fn new(door: D, product_version: impl Into<String>) -> Self {
        Self {
            door,
            product_version: product_version.into(),
        }
    }

    /// Handle one JSON-RPC request, returning the response to write.
    ///
    /// `None` for a notification, which by JSON-RPC's own rules gets no
    /// response — writing one to a harness's stdin is how a client's parser
    /// desynchronises.
    pub fn handle(&self, request: &serde_json::Value) -> Option<serde_json::Value> {
        let id = request.get("id").cloned();
        let name = request.get("method").and_then(serde_json::Value::as_str);
        let Some(method) = name.and_then(Method::from_name) else {
            // A GET or a DELETE has no analogue over stdio; an unknown method
            // is the whole of v0's `405` here.
            return id.map(|id| {
                error_response(
                    &id,
                    METHOD_NOT_FOUND,
                    &format!("{SERVER_NAME} does not serve `{}`", name.unwrap_or("")),
                )
            });
        };
        match method {
            // A notification: no id, no answer.
            Method::Initialized => None,
            Method::Ping => id.map(|id| result_response(&id, serde_json::json!({}))),
            Method::Initialize => id.map(|id| {
                result_response(
                    &id,
                    serde_json::json!({
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": { "tools": {} },
                        "serverInfo": {
                            "name": SERVER_NAME,
                            "version": self.product_version,
                        }
                    }),
                )
            }),
            Method::ToolsList => id.map(|id| {
                let tools: Vec<serde_json::Value> = Tool::all()
                    .into_iter()
                    .map(|tool| {
                        serde_json::json!({
                            "name": tool.name(),
                            "description": tool.description(),
                            "inputSchema": tool.input_schema(),
                        })
                    })
                    .collect();
                result_response(&id, serde_json::json!({ "tools": tools }))
            }),
            Method::ToolsCall => {
                let id = id?;
                Some(self.call(&id, request.get("params")))
            }
        }
    }

    fn call(
        &self,
        id: &serde_json::Value,
        params: Option<&serde_json::Value>,
    ) -> serde_json::Value {
        let Some(params) = params else {
            return error_response(id, INVALID_PARAMS, "tools/call takes params");
        };
        let name = params.get("name").and_then(serde_json::Value::as_str);
        let Some(tool) = name.and_then(Tool::from_name) else {
            return error_response(
                id,
                INVALID_PARAMS,
                &format!("no tool named `{}`", name.unwrap_or("")),
            );
        };
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        match tool {
            Tool::VaultSql => {
                let Some(sql) = arguments.get("sql").and_then(serde_json::Value::as_str) else {
                    return error_response(id, INVALID_PARAMS, "vault_sql takes a `sql` string");
                };
                // A REFUSAL IS A TOOL RESULT, NOT A PROTOCOL ERROR. The model
                // must be able to read "you may not do that" and stop; a
                // JSON-RPC error is a transport fault and harnesses retry
                // those.
                match sql_guard::check(sql, self.door.caller()) {
                    Err(refusal) => tool_error(id, &refusal.to_string()),
                    Ok(checked) => match self.door.query(&checked, sql_guard::MAX_ROWS) {
                        Err(error) => tool_error(id, &error.to_string()),
                        Ok(rows) => tool_json(
                            id,
                            &serde_json::json!({
                                "columns": rows.columns,
                                "rows": rows.rows,
                                "truncated": rows.truncated,
                            }),
                        ),
                    },
                }
            }
            Tool::AttachmentsList => tool_json(id, &serde_json::json!({ "attachments": [] })),
            Tool::AttachmentsRead => {
                let Some(hash) = arguments.get("hash").and_then(serde_json::Value::as_str) else {
                    return error_response(
                        id,
                        INVALID_PARAMS,
                        "attachments_read takes a `hash` string",
                    );
                };
                match self.door.attachment(hash) {
                    Err(error) => tool_error(id, &error.to_string()),
                    Ok(None) => tool_error(id, "no attachment with that hash is visible here"),
                    Ok(Some((mime, data))) => {
                        tool_json(id, &serde_json::json!({ "mime": mime, "dataBase64": data }))
                    }
                }
            }
        }
    }
}

fn result_response(id: &serde_json::Value, result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: &serde_json::Value, code: i64, message: &str) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

/// A tool result carrying `isError: true`. MCP's own shape for "the tool ran
/// and said no".
fn tool_error(id: &serde_json::Value, message: &str) -> serde_json::Value {
    result_response(
        id,
        serde_json::json!({
            "content": [{ "type": "text", "text": message }],
            "isError": true
        }),
    )
}

fn tool_json(id: &serde_json::Value, value: &serde_json::Value) -> serde_json::Value {
    result_response(
        id,
        serde_json::json!({
            "content": [{
                "type": "text",
                "text": serde_json::to_string(value).unwrap_or_else(|_| "{}".to_owned())
            }],
            "isError": false
        }),
    )
}

/// A door over an in-process vault.
///
/// The single-process case and the one tests use. `Vault::read` sets
/// `PRAGMA query_only = ON` for the duration, which is the layer that makes the
/// statement grammar a defence rather than the defence.
pub struct HandleDoor<'v> {
    vault: &'v centraid_vault::Vault,
    caller: Caller,
}

impl<'v> HandleDoor<'v> {
    #[must_use]
    pub const fn new(vault: &'v centraid_vault::Vault, caller: Caller) -> Self {
        Self { vault, caller }
    }
}

impl SeatDoor for HandleDoor<'_> {
    fn caller(&self) -> Caller {
        self.caller
    }

    fn query(&self, checked: &sql_guard::Checked, max_rows: usize) -> Result<Rows, DoorError> {
        // The statement text never appears in this crate: it arrives checked
        // and is executed by the vault, which is the crate `sql-confinement`
        // puts SQL in.
        centraid_vault::ledger::sql_guard::run_checked(self.vault, checked, max_rows)
            .map(|(columns, rows, truncated)| Rows {
                columns,
                rows,
                truncated,
            })
            .map_err(|error| DoorError::Transport(error.to_string()))
    }

    fn attachment(&self, _hash: &str) -> Result<Option<(String, String)>, DoorError> {
        Err(DoorError::Unavailable {
            what: "attachments_read",
            because: "the blob store reaches this door through the seat socket",
        })
    }
}

/// A door over lane F's seat socket.
///
/// What ships. `vault_sql` is answered as unavailable until the local channel
/// carries an owner-only statement message — see the module header. The
/// alternative, opening the vault file from this child process, is refused on
/// purpose: it would be a second writer of the one file and a second gateway.
pub struct SocketDoor {
    socket_path: std::path::PathBuf,
    token: String,
    caller: Caller,
}

/// Hand-written so the token is **never** in a debug line. v0's rule for its
/// bearer was the same (`vault-mcp-server.ts:18`–`:28`: *minted per turn,
/// passed only through the `mcpServers` entry, never logged*), and a derived
/// `Debug` would put it in the first `dbg!` somebody reaches for.
impl std::fmt::Debug for SocketDoor {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("SocketDoor")
            .field("socket_path", &self.socket_path)
            .field("caller", &self.caller)
            .field("token", &"<redacted>")
            .finish()
    }
}

impl SocketDoor {
    /// Read the socket path and the per-turn token from the environment the
    /// harness was handed.
    pub fn from_env(
        env: &std::collections::BTreeMap<String, String>,
        caller: Caller,
    ) -> Result<Self, DoorError> {
        let socket_path = env.get(SEAT_SOCKET_ENV).ok_or(DoorError::Unavailable {
            what: "the seat socket",
            because: "CENTRAID_SEAT_SOCKET is not set; the shell sets it when it spawns this child",
        })?;
        let token = env.get(TURN_TOKEN_ENV).ok_or(DoorError::Unavailable {
            what: "the seat socket",
            because: "CENTRAID_TURN_TOKEN is not set; a child needs the capability token the \
                      shell mints for it",
        })?;
        Ok(Self {
            socket_path: std::path::PathBuf::from(socket_path),
            token: token.clone(),
            caller,
        })
    }

    #[must_use]
    pub fn socket_path(&self) -> &std::path::Path {
        &self.socket_path
    }

    /// The token, for the `Hello` this door sends. Never logged.
    #[must_use]
    pub fn token(&self) -> &str {
        &self.token
    }
}

impl SeatDoor for SocketDoor {
    fn caller(&self) -> Caller {
        self.caller
    }

    fn query(&self, _checked: &sql_guard::Checked, _max_rows: usize) -> Result<Rows, DoorError> {
        Err(DoorError::Unavailable {
            what: "vault_sql",
            because: "the seat socket's local channel carries named reads and commands, not a \
                      free-form statement; the owner-only statement message is a hand-off",
        })
    }

    fn attachment(&self, _hash: &str) -> Result<Option<(String, String)>, DoorError> {
        Err(DoorError::Unavailable {
            what: "attachments_read",
            because: "the blob range message is wired in the same hand-off",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake {
        caller: Caller,
    }

    impl SeatDoor for Fake {
        fn caller(&self) -> Caller {
            self.caller
        }
        fn query(&self, checked: &sql_guard::Checked, _max: usize) -> Result<Rows, DoorError> {
            assert!(!checked.statement().is_empty());
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

    fn owner_server() -> Server<Fake> {
        Server::new(
            Fake {
                caller: Caller::Owner,
            },
            "1.0.0-alpha.0",
        )
    }

    fn request(id: i64, method: &str, params: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    #[test]
    fn initialize_reports_tools_and_a_version() {
        let answer = owner_server()
            .handle(&request(1, "initialize", serde_json::json!({})))
            .expect("initialize is a request");
        assert_eq!(answer["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(answer["result"]["serverInfo"]["name"], SERVER_NAME);
        assert!(answer["result"]["capabilities"]["tools"].is_object());
    }

    #[test]
    fn the_initialized_notification_gets_no_answer() {
        let notification =
            serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(
            owner_server().handle(&notification).is_none(),
            "a response to a notification desynchronises the client's parser"
        );
    }

    #[test]
    fn tools_list_is_exactly_the_three() {
        let answer = owner_server()
            .handle(&request(2, "tools/list", serde_json::json!({})))
            .expect("a request");
        let names: Vec<&str> = answer["result"]["tools"]
            .as_array()
            .expect("an array")
            .iter()
            .map(|tool| tool["name"].as_str().expect("a name"))
            .collect();
        assert_eq!(names, ["vault_sql", "attachments_list", "attachments_read"]);
    }

    #[test]
    fn an_unknown_method_is_method_not_found() {
        let answer = owner_server()
            .handle(&request(3, "resources/list", serde_json::json!({})))
            .expect("a request");
        assert_eq!(answer["error"]["code"], METHOD_NOT_FOUND);
    }

    #[test]
    fn an_owner_sql_call_returns_rows() {
        let answer = owner_server()
            .handle(&request(
                4,
                "tools/call",
                serde_json::json!({ "name": "vault_sql", "arguments": { "sql": "select 1 as n" } }),
            ))
            .expect("a request");
        assert_eq!(answer["result"]["isError"], false);
        let text = answer["result"]["content"][0]["text"]
            .as_str()
            .expect("text");
        assert!(text.contains("\"columns\""));
    }

    #[test]
    fn an_agent_sql_call_is_a_tool_error_not_a_protocol_error() {
        let server = Server::new(
            Fake {
                caller: Caller::Scoped { name: "assistant" },
            },
            "1.0.0-alpha.0",
        );
        let answer = server
            .handle(&request(
                5,
                "tools/call",
                serde_json::json!({
                    "name": "vault_sql",
                    "arguments": { "sql": "select * from core_content_item" }
                }),
            ))
            .expect("a request");
        assert!(
            answer.get("error").is_none(),
            "a refusal must be readable by the model, not a transport fault it retries"
        );
        assert_eq!(answer["result"]["isError"], true);
        assert!(
            answer["result"]["content"][0]["text"]
                .as_str()
                .expect("text")
                .contains("owner"),
            "the refusal says what the boundary is"
        );
    }

    #[test]
    fn a_write_through_the_tool_is_refused() {
        let answer = owner_server()
            .handle(&request(
                6,
                "tools/call",
                serde_json::json!({
                    "name": "vault_sql",
                    "arguments": { "sql": "delete from core_party" }
                }),
            ))
            .expect("a request");
        assert_eq!(answer["result"]["isError"], true);
    }

    #[test]
    fn the_socket_door_names_what_it_is_missing() {
        let mut env = std::collections::BTreeMap::new();
        assert!(SocketDoor::from_env(&env, Caller::Owner).is_err());
        env.insert(SEAT_SOCKET_ENV.to_owned(), "/run/seat.sock".to_owned());
        let error = SocketDoor::from_env(&env, Caller::Owner)
            .expect_err("a child with no token must not connect");
        assert!(error.to_string().contains("CENTRAID_TURN_TOKEN"));
        env.insert(TURN_TOKEN_ENV.to_owned(), "t-1".to_owned());
        let door = SocketDoor::from_env(&env, Caller::Owner).expect("both are set");
        assert_eq!(door.socket_path(), std::path::Path::new("/run/seat.sock"));
    }
}
