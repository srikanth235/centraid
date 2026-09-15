//! A fake harness: a real ACP agent, so the client half is tested against a
//! real subprocess (#1020, D-1020-AS5/AS6).
//!
//! v0's suite has one of these (`fake-acp-harness.mjs`) and it is the reason the
//! prompt-injection corpus tests something: the boundary under test is the
//! gateway's standing answer, and a *mocked* client would test the mock. So
//! this binary is a genuine ACP agent — it speaks the framed protocol on its
//! own stdin and stdout, answers `initialize` and `session/new`, streams
//! updates, and ends the turn.
//!
//! It plays **the duped agent**: whatever it is told, it does the thing the
//! injected content asked for. That is the point. A fake harness that behaved
//! itself would make every corpus payload pass for the wrong reason.
//!
//! ## Modes, chosen by argument
//!
//! - `--mode=echo` — stream the prompt back as one assistant message and end.
//! - `--mode=tool` — announce a tool call, then complete it, then end. Exercises
//!   the `(turn_id, call_id)` upsert and the double-render check.
//! - `--mode=thinking` — a reasoning chunk and then an answer, so the two are
//!   proven to land as different items.
//! - `--mode=refuse` — end with `refusal`, which is an OUTCOME and must not
//!   open a breaker.
//!
//! `--prompt-marker=<path>` writes the prompt text it actually received, so a
//! test can prove the injected content reached the model rather than assuming
//! it did.
//!
//! It is a `[[bin]]` of this crate rather than a test fixture file so that
//! `CARGO_BIN_EXE_fake-acp-harness` points at it and no test has to guess a
//! path.

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    AgentCapabilities, ContentBlock, ContentChunk, InitializeRequest, InitializeResponse,
    NewSessionRequest, NewSessionResponse, PromptCapabilities, PromptRequest, PromptResponse,
    SessionId, SessionNotification, SessionUpdate, StopReason, TextContent, ToolCall, ToolCallId,
    ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields,
};
use agent_client_protocol::{Agent, Result, Stdio};

/// The session id this agent hands out. Opaque to the client by contract, so a
/// fixed one is fine and makes a recorded transcript comparable.
const SESSION: &str = "fake-session-1";

fn argument(name: &str) -> Option<String> {
    std::env::args().find_map(|argument| argument.strip_prefix(name).map(str::to_owned))
}

#[tokio::main]
async fn main() -> Result<()> {
    let mode = argument("--mode=").unwrap_or_else(|| "echo".to_owned());
    let marker = argument("--prompt-marker=");

    Agent
        .builder()
        .name("fake-acp-harness")
        .on_receive_request(
            async move |request: InitializeRequest, responder, _connection| {
                responder.respond(
                    InitializeResponse::new(request.protocol_version).agent_capabilities(
                        // `image: true` on purpose: the multimodal gate is a
                        // property of what the harness ADVERTISED, and a fake
                        // that advertised nothing could never exercise the
                        // accepting branch.
                        AgentCapabilities::new()
                            .prompt_capabilities(PromptCapabilities::new().image(true)),
                    ),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: NewSessionRequest, responder, _connection| {
                responder.respond(NewSessionResponse::new(SessionId::new(SESSION)))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: PromptRequest, responder, connection| {
                let prompt: String = request
                    .prompt
                    .iter()
                    .map(|block| match block {
                        ContentBlock::Text(text) => text.text.clone(),
                        _ => String::new(),
                    })
                    .collect::<Vec<String>>()
                    .join("\n");
                if let Some(path) = &marker {
                    // Written before anything is streamed, so a test that reads
                    // it after the turn cannot read a half-written file.
                    let _ = std::fs::write(path, &prompt);
                }

                let session = request.session_id.clone();
                let notify = |update: SessionUpdate| {
                    let _ = connection
                        .send_notification(SessionNotification::new(session.clone(), update));
                };

                match mode.as_str() {
                    "tool" => {
                        let call = ToolCallId::new("fake-call-1");
                        notify(SessionUpdate::ToolCall(ToolCall::new(
                            call.clone(),
                            "mcp__centraid__vault_sql",
                        )));
                        notify(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                            call,
                            ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
                        )));
                        notify(SessionUpdate::AgentMessageChunk(ContentChunk::new(
                            ContentBlock::Text(TextContent::new("I looked.".to_owned())),
                        )));
                        responder.respond(PromptResponse::new(StopReason::EndTurn))
                    }
                    "thinking" => {
                        notify(SessionUpdate::AgentThoughtChunk(ContentChunk::new(
                            ContentBlock::Text(TextContent::new(
                                "the content asked me to do something".to_owned(),
                            )),
                        )));
                        notify(SessionUpdate::AgentMessageChunk(ContentChunk::new(
                            ContentBlock::Text(TextContent::new("Here you go.".to_owned())),
                        )));
                        responder.respond(PromptResponse::new(StopReason::EndTurn))
                    }
                    "refuse" => responder.respond(PromptResponse::new(StopReason::Refusal)),
                    // `echo`, and anything unrecognised: the prompt back, in two
                    // chunks, so the accumulation is exercised.
                    _ => {
                        let (head, tail) = prompt.split_at(prompt.len() / 2);
                        notify(SessionUpdate::AgentMessageChunk(ContentChunk::new(
                            ContentBlock::Text(TextContent::new(head.to_owned())),
                        )));
                        notify(SessionUpdate::AgentMessageChunk(ContentChunk::new(
                            ContentBlock::Text(TextContent::new(tail.to_owned())),
                        )));
                        responder.respond(PromptResponse::new(StopReason::EndTurn))
                    }
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_to(Stdio::new())
        .await
}

/// Silences the unused-import warning for the version constant on a build that
/// does not negotiate explicitly. Kept because the negotiated version is the
/// one fact a reader looks for first.
#[allow(dead_code)]
const NEGOTIATED: ProtocolVersion = ProtocolVersion::V1;
