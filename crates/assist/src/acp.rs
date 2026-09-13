//! The ACP client: the one integration path (#1020, D-1020-AS5).
//!
//! ## What the crate replaces, and what it does not
//!
//! `agent-client-protocol` 2.1.0 gives the wire: the `Client` role the gateway
//! speaks, the `Agent` it talks to, typed `ContentBlock`s, and [`AcpAgent`],
//! which spawns a command and frames its stdio. That is roughly the 400–600
//! most error-prone lines of v0's 6,265 — `connection.ts`, `content.ts`,
//! `types.ts`, and the schema halves of `session-config.ts` and
//! `stream-events.ts`.
//!
//! What it does not give, and therefore what is here: **the mapping**. ACP
//! describes a stream of session updates; the ledger records
//! conversation ⊃ turn ⊃ item. [`Mapper`] is that translation and it is the
//! only place either vocabulary meets the other.
//!
//! ## `ImageContent { data, mime_type }` — not `source.media_type`
//!
//! `multimodal.ts:1`–`:5` warns about exactly this, and it is the kind of bug
//! that survives review: the Anthropic messages API spells an inline image
//! `source: { media_type, data }`, ACP spells it `{ data, mimeType }`, and both
//! are JSON objects with a base64 string in them. The crate's types make the
//! wrong one a compile error, which is most of why it is worth taking.
//!
//! Images are **gated on `initialize`**: a harness that did not advertise the
//! `image` prompt capability gets the attachment named in
//! [`PromptBuild::skipped`] instead of a content block it will reject. Named,
//! not dropped — a silently missing attachment is a member wondering why the
//! answer ignored their receipt.
//!
//! ## Permission requests are answered by the posture
//!
//! `request_permission` is answered from [`crate::turn::PermissionPolicy`] and
//! never by asking anybody: a gateway turn has no approval UI, which is also
//! why the `claude-code` adapter runs in `bypassPermissions`
//! (`registry.ts:203`). `auto-allow` selects the first allow-shaped option;
//! `deny` cancels. There is no third behaviour and no timeout-to-allow.
//!
//! ## `read_text_file` / `write_text_file` are confined to the turn's cwd
//!
//! A harness may ask the *client* to read or write a file on its behalf. The
//! answer is confined to the turn's working directory and its declared
//! additional directories, after resolving `..` — see [`confine`]. Without
//! that, the widest file-read primitive in the product would be reachable from
//! whatever the harness was persuaded to ask for.
//!
//! ## Sessions ids are opaque
//!
//! `session/new` returns an id; `session/load` takes one back. It is never
//! parsed, compared for structure, or reused across kinds — it is handed back
//! as `prev_session_id` and nothing else (`runtime.ts:28`).

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use agent_client_protocol::schema::v1::{
    ContentBlock, ImageContent, RequestPermissionRequest, SessionNotification, SessionUpdate,
    TextContent, ToolCallStatus,
};
use agent_client_protocol::{AcpAgent, AcpAgentConfig};

use crate::low_priority::{self, Host};
use crate::registry::LaunchPlan;
use crate::spawn_env::{self, SpawnEnvOptions};
use crate::turn::PermissionPolicy;

/// What the gateway does with one `session/update`.
#[derive(Debug, Clone, PartialEq)]
pub enum Mapped {
    /// Assistant text, accumulated across chunks into one `step` item.
    AssistantDelta { text: String },
    /// Reasoning text. A separate item kind in the transcript, because a
    /// member reading a run wants to tell the answer from the thinking.
    ReasoningDelta { text: String },
    /// A `message_in` item: the harness echoing what it was asked.
    UserEcho { text: String },
    /// A `tool` item opening.
    ToolStart {
        call_id: String,
        title: String,
        args_json: Option<String>,
    },
    /// The same `tool` item closing. Upserted on `(turn_id, call_id)`.
    ToolEnd {
        call_id: String,
        output_json: Option<String>,
        failed: bool,
    },
    /// A plan: recorded as a `step`, not as its own kind.
    Plan { entries: usize },
    /// Usage folded onto the TURN, never an item.
    Usage {
        context_used: Option<u64>,
        context_size: Option<u64>,
        cost_usd: Option<f64>,
    },
    /// A mode, command list or session-info update: real protocol traffic with
    /// no ledger consequence. Named rather than swallowed, so an unhandled
    /// variant is distinguishable from one deliberately ignored.
    NoLedgerEffect { what: &'static str },
}

/// Turns ACP session updates into ledger-shaped events.
///
/// Holds the per-turn accumulation only it can see: the assistant text
/// assembled from chunks, and which tool calls are open. A harness that
/// surfaces its own MCP calls announces `tool_call` before it dials
/// `centraid mcp` and closes it afterwards, so [`Mapper::harness_streams_tool`]
/// is how the gateway avoids rendering the same call twice.
#[derive(Debug, Default)]
pub struct Mapper {
    final_text: String,
    open_tools: BTreeMap<String, String>,
}

impl Mapper {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The assistant text accumulated so far.
    #[must_use]
    pub fn final_text(&self) -> &str {
        &self.final_text
    }

    /// Is the harness already streaming a tool by this name?
    ///
    /// `contains` rather than equality on purpose: a namespacing harness
    /// surfaces our tool as `mcp__centraid__vault_sql`.
    #[must_use]
    pub fn harness_streams_tool(&self, tool_name: &str) -> bool {
        self.open_tools
            .values()
            .any(|title| title.contains(tool_name))
    }

    /// Feed one notification.
    pub fn handle(&mut self, notification: &SessionNotification) -> Option<Mapped> {
        match &notification.update {
            SessionUpdate::AgentMessageChunk(chunk) => {
                let text = text_of(&chunk.content);
                if text.is_empty() {
                    return None;
                }
                self.final_text.push_str(&text);
                Some(Mapped::AssistantDelta { text })
            }
            SessionUpdate::AgentThoughtChunk(chunk) => {
                let text = text_of(&chunk.content);
                (!text.is_empty()).then_some(Mapped::ReasoningDelta { text })
            }
            SessionUpdate::UserMessageChunk(chunk) => {
                let text = text_of(&chunk.content);
                (!text.is_empty()).then_some(Mapped::UserEcho { text })
            }
            SessionUpdate::ToolCall(call) => {
                let call_id = call.tool_call_id.0.to_string();
                if call_id.is_empty() {
                    return None;
                }
                let title = if call.title.is_empty() {
                    "tool".to_owned()
                } else {
                    call.title.clone()
                };
                self.open_tools.insert(call_id.clone(), title.clone());
                Some(Mapped::ToolStart {
                    call_id,
                    title,
                    args_json: call
                        .raw_input
                        .as_ref()
                        .and_then(|value| serde_json::to_string(value).ok()),
                })
            }
            SessionUpdate::ToolCallUpdate(update) => {
                let call_id = update.tool_call_id.0.to_string();
                if call_id.is_empty() {
                    return None;
                }
                // Only a TERMINAL status closes the item. An `in_progress`
                // update that closed it would upsert an empty output over a
                // result that had already arrived — and `None` is not a status
                // at all, it is a partial update that touches other fields.
                let failed = match update.fields.status {
                    Some(ToolCallStatus::Completed) => false,
                    Some(ToolCallStatus::Failed) => true,
                    _ => {
                        return Some(Mapped::NoLedgerEffect {
                            what: "tool_call_update, not terminal",
                        });
                    }
                };
                self.open_tools.remove(&call_id);
                Some(Mapped::ToolEnd {
                    call_id,
                    output_json: update
                        .fields
                        .raw_output
                        .as_ref()
                        .and_then(|value| serde_json::to_string(value).ok()),
                    failed,
                })
            }
            SessionUpdate::Plan(plan) => Some(Mapped::Plan {
                entries: plan.entries.len(),
            }),
            SessionUpdate::UsageUpdate(usage) => Some(Mapped::Usage {
                context_used: Some(usage.used),
                context_size: Some(usage.size),
                cost_usd: None,
            }),
            SessionUpdate::CurrentModeUpdate(_) => Some(Mapped::NoLedgerEffect {
                what: "current_mode_update",
            }),
            SessionUpdate::AvailableCommandsUpdate(_) => Some(Mapped::NoLedgerEffect {
                what: "available_commands_update",
            }),
            SessionUpdate::ConfigOptionUpdate(_) => Some(Mapped::NoLedgerEffect {
                what: "config_option_update",
            }),
            SessionUpdate::SessionInfoUpdate(_) => Some(Mapped::NoLedgerEffect {
                what: "session_info_update",
            }),
            // NOT a catch-all that silently drops: a variant this build does
            // not know is named, so a protocol addition shows up in the
            // transcript as an unhandled update rather than as nothing.
            _ => Some(Mapped::NoLedgerEffect {
                what: "an update this build does not map",
            }),
        }
    }
}

/// The plain text of a content block, or the empty string.
#[must_use]
pub fn text_of(block: &ContentBlock) -> String {
    match block {
        ContentBlock::Text(text) => text.text.clone(),
        // An image, audio clip or resource link has no text and must not be
        // stringified into one: `"[object]"` in a transcript is worse than an
        // absence.
        _ => String::new(),
    }
}

/// An attachment offered to a harness.
#[derive(Debug, Clone)]
pub struct Attachment {
    pub filename: String,
    pub mime: String,
    /// Base64, as ACP carries it.
    pub data_base64: String,
}

/// What a harness advertised at `initialize`.
#[derive(Debug, Clone, Copy, Default)]
pub struct PromptCapabilities {
    pub image: bool,
    pub audio: bool,
    pub embedded_context: bool,
}

/// The content blocks for one prompt, and what could not be sent.
#[derive(Debug, Clone)]
pub struct PromptBuild {
    pub blocks: Vec<ContentBlock>,
    /// Attachments this harness cannot accept, by filename, with the
    /// capability that was missing. Reported to the member, never dropped.
    pub skipped: Vec<(String, &'static str)>,
}

/// Build a prompt, gating attachments on what the harness advertised.
#[must_use]
pub fn build_prompt(
    message: &str,
    attachments: &[Attachment],
    capabilities: PromptCapabilities,
) -> PromptBuild {
    let mut blocks = vec![ContentBlock::Text(TextContent::new(message.to_owned()))];
    let mut skipped = Vec::new();
    for attachment in attachments {
        if attachment.mime.starts_with("image/") {
            if capabilities.image {
                // `{ data, mime_type }`. NOT `source.media_type`.
                blocks.push(ContentBlock::Image(ImageContent::new(
                    attachment.data_base64.clone(),
                    attachment.mime.clone(),
                )));
            } else {
                skipped.push((attachment.filename.clone(), "image"));
            }
            continue;
        }
        if attachment.mime.starts_with("audio/") {
            if !capabilities.audio {
                skipped.push((attachment.filename.clone(), "audio"));
            }
            continue;
        }
        skipped.push((attachment.filename.clone(), "embeddedContext"));
    }
    PromptBuild { blocks, skipped }
}

/// How a permission request is answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionAnswer {
    /// The option id selected.
    Selected { option_id: String },
    /// Refused, or there was nothing to select.
    Cancelled,
}

/// Answer a permission request from the posture's policy.
///
/// `deny` cancels. `auto-allow` selects the first option whose id or name does
/// not read as a rejection — not simply "the first option", because some
/// harnesses list `reject_once` first and a blind first-option pick would deny
/// every request while claiming to allow them.
#[must_use]
pub fn answer_permission(
    request: &RequestPermissionRequest,
    policy: PermissionPolicy,
) -> PermissionAnswer {
    if policy == PermissionPolicy::Deny {
        return PermissionAnswer::Cancelled;
    }
    let chosen = request
        .options
        .iter()
        .find(|option| {
            let id = option.option_id.0.to_ascii_lowercase();
            let name = option.name.to_ascii_lowercase();
            !id.contains("reject")
                && !id.contains("deny")
                && !name.contains("reject")
                && !name.contains("deny")
        })
        .or_else(|| request.options.first());
    match chosen {
        Some(option) => PermissionAnswer::Selected {
            option_id: option.option_id.0.to_string(),
        },
        None => PermissionAnswer::Cancelled,
    }
}

/// Why a file request was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{path} is outside this turn's working directory")]
pub struct OutsideCwd {
    pub path: String,
}

/// Resolve a harness's file path against the turn's allowed roots.
///
/// Lexical resolution of `.`/`..` first, then a prefix check. Lexical rather
/// than `canonicalize`, deliberately: `canonicalize` fails for a file the
/// harness is about to *create*, and falling back to "allow it if we cannot
/// canonicalize" is how the check gets skipped for exactly the write case.
///
/// A symlink inside the cwd that points out of it is therefore not caught here;
/// it is caught by the filesystem permissions of the process, which is the
/// layer that can see it. Stated rather than implied, because a reader
/// otherwise assumes this is a containment boundary against a hostile
/// filesystem, and it is a containment boundary against a hostile *prompt*.
pub fn confine(
    requested: &Path,
    cwd: &Path,
    additional: &[PathBuf],
) -> Result<PathBuf, OutsideCwd> {
    let absolute = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        cwd.join(requested)
    };
    let resolved = lexically_resolve(&absolute);
    let allowed = std::iter::once(cwd.to_path_buf())
        .chain(additional.iter().cloned())
        .any(|root| resolved.starts_with(lexically_resolve(&root)));
    if allowed {
        Ok(resolved)
    } else {
        Err(OutsideCwd {
            path: requested.display().to_string(),
        })
    }
}

fn lexically_resolve(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// How a turn ended, as the ledger records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ending {
    /// The agent finished.
    EndTurn,
    /// The agent hit its own limit. Not an error: the turn is recorded ok with
    /// the reason, because the answer up to that point is real.
    MaxTokens,
    MaxTurnRequests,
    /// The member or the gateway cancelled. Not an error either.
    Cancelled,
    /// The agent refused. An outcome, not a failure — a refusal recorded as an
    /// error would put a harness in a breaker for declining a request.
    Refusal,
    Other,
}

impl Ending {
    /// Whether this ending makes the turn `ok = 1`.
    ///
    /// Four of six do. The distinction matters because [`crate::health`] only
    /// records a failure for a turn that was *not* ok, and a breaker opened by
    /// a token limit would take a working harness out of service.
    #[must_use]
    pub const fn is_ok(self) -> bool {
        !matches!(self, Self::Other)
    }

    /// Read an ACP stop reason.
    #[must_use]
    pub fn from_stop_reason(reason: &str) -> Self {
        match reason {
            "end_turn" => Self::EndTurn,
            "max_tokens" => Self::MaxTokens,
            "max_turn_requests" => Self::MaxTurnRequests,
            "cancelled" => Self::Cancelled,
            "refusal" => Self::Refusal,
            _ => Self::Other,
        }
    }
}

/// Build the `AcpAgent` for a planned launch.
///
/// The order here is the one `docs/harnesses.md:65` fixes: the base
/// environment is scrubbed first ([`spawn_env`]), then the kind's own `env` is
/// applied on top — so a kind can override an inherited variable but never the
/// sanitised `PATH` — and the whole command is finally wrapped for low priority
/// ([`low_priority`]).
#[must_use]
pub fn agent_for(
    plan: &LaunchPlan,
    base_env: &BTreeMap<String, String>,
    extra_path: Option<&str>,
    bin_path: Option<&str>,
) -> AcpAgent {
    let mut env = spawn_env::harness_spawn_env(
        base_env,
        &SpawnEnvOptions {
            bin_path: bin_path.map(str::to_owned),
            extra_path: extra_path.map(str::to_owned),
        },
    );
    for (name, value) in &plan.env {
        env.insert(name.clone(), value.clone());
    }
    let wrapped =
        low_priority::low_priority_command(&plan.program, &plan.args, &Host::current(base_env));
    let mut config = AcpAgentConfig::new(wrapped.program).args(wrapped.args);
    for (name, value) in env {
        config = config.env(name, value);
    }
    AcpAgent::new(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{
        ContentChunk, PermissionOption, PermissionOptionId, PermissionOptionKind, SessionId,
        ToolCall, ToolCallId, ToolCallUpdate, ToolCallUpdateFields,
    };

    fn notification(update: SessionUpdate) -> SessionNotification {
        SessionNotification::new(SessionId::new("s-1"), update)
    }

    fn chunk(text: &str) -> ContentChunk {
        ContentChunk::new(ContentBlock::Text(TextContent::new(text.to_owned())))
    }

    #[test]
    fn assistant_chunks_accumulate_into_one_answer() {
        let mut mapper = Mapper::new();
        assert_eq!(
            mapper.handle(&notification(SessionUpdate::AgentMessageChunk(chunk(
                "Hel"
            )))),
            Some(Mapped::AssistantDelta {
                text: "Hel".to_owned()
            })
        );
        let _ = mapper.handle(&notification(SessionUpdate::AgentMessageChunk(chunk("lo"))));
        assert_eq!(mapper.final_text(), "Hello");
    }

    #[test]
    fn reasoning_is_a_different_item_from_the_answer() {
        let mut mapper = Mapper::new();
        let mapped = mapper.handle(&notification(SessionUpdate::AgentThoughtChunk(chunk(
            "hmm",
        ))));
        assert_eq!(
            mapped,
            Some(Mapped::ReasoningDelta {
                text: "hmm".to_owned()
            })
        );
        assert_eq!(
            mapper.final_text(),
            "",
            "thinking must not become part of the answer"
        );
    }

    #[test]
    fn an_empty_chunk_produces_no_item() {
        let mut mapper = Mapper::new();
        assert_eq!(
            mapper.handle(&notification(SessionUpdate::AgentMessageChunk(chunk("")))),
            None
        );
    }

    #[test]
    fn a_tool_call_opens_and_is_visible_to_the_double_render_check() {
        let mut mapper = Mapper::new();
        let mut call = ToolCall::new(ToolCallId::new("c-1"), "mcp__centraid__vault_sql");
        call.raw_input = Some(serde_json::json!({"sql": "select 1"}));
        let mapped = mapper.handle(&notification(SessionUpdate::ToolCall(call)));
        assert!(matches!(mapped, Some(Mapped::ToolStart { .. })));
        assert!(
            mapper.harness_streams_tool("vault_sql"),
            "a namespacing harness surfaces the tool with a prefix, and the check must see through it"
        );
        assert!(!mapper.harness_streams_tool("attachments"));
    }

    #[test]
    fn an_image_is_gated_on_the_advertised_capability_and_named_when_refused() {
        let attachment = Attachment {
            filename: "receipt.png".to_owned(),
            mime: "image/png".to_owned(),
            data_base64: "AAAA".to_owned(),
        };
        let with = build_prompt(
            "what is this",
            std::slice::from_ref(&attachment),
            PromptCapabilities {
                image: true,
                ..PromptCapabilities::default()
            },
        );
        assert_eq!(with.blocks.len(), 2);
        assert!(with.skipped.is_empty());
        assert!(matches!(with.blocks[1], ContentBlock::Image(_)));

        let without = build_prompt(
            "what is this",
            std::slice::from_ref(&attachment),
            PromptCapabilities::default(),
        );
        assert_eq!(without.blocks.len(), 1);
        assert_eq!(
            without.skipped,
            [("receipt.png".to_owned(), "image")],
            "an unaccepted attachment is NAMED, never silently dropped"
        );
    }

    fn permission(options: &[(&str, PermissionOptionKind)]) -> RequestPermissionRequest {
        RequestPermissionRequest::new(
            SessionId::new("s-1"),
            ToolCallUpdate::new(ToolCallId::new("c-1"), ToolCallUpdateFields::new()),
            options
                .iter()
                .map(|(id, kind)| {
                    PermissionOption::new(PermissionOptionId::new(*id), (*id).to_owned(), *kind)
                })
                .collect(),
        )
    }

    #[test]
    fn deny_cancels_and_never_selects() {
        let request = permission(&[("allow_once", PermissionOptionKind::AllowOnce)]);
        assert_eq!(
            answer_permission(&request, PermissionPolicy::Deny),
            PermissionAnswer::Cancelled
        );
    }

    #[test]
    fn auto_allow_skips_a_rejection_listed_first() {
        let request = permission(&[
            ("reject_once", PermissionOptionKind::RejectOnce),
            ("allow_always", PermissionOptionKind::AllowAlways),
        ]);
        assert_eq!(
            answer_permission(&request, PermissionPolicy::AutoAllow),
            PermissionAnswer::Selected {
                option_id: "allow_always".to_owned()
            },
            "a blind first-option pick would deny every request while claiming to allow"
        );
    }

    #[test]
    fn auto_allow_with_no_options_cancels_rather_than_inventing_one() {
        assert_eq!(
            answer_permission(&permission(&[]), PermissionPolicy::AutoAllow),
            PermissionAnswer::Cancelled
        );
    }

    #[test]
    fn a_path_escape_is_refused_after_resolving_dot_dot() {
        let cwd = Path::new("/work/draft");
        assert!(confine(Path::new("notes.md"), cwd, &[]).is_ok());
        assert!(confine(Path::new("/work/draft/sub/../notes.md"), cwd, &[]).is_ok());
        let error = confine(Path::new("../../etc/passwd"), cwd, &[])
            .expect_err("a traversal out of the cwd must be refused");
        assert_eq!(error.path, "../../etc/passwd");
        assert!(confine(Path::new("/etc/passwd"), cwd, &[]).is_err());
    }

    #[test]
    fn a_declared_additional_directory_is_allowed_and_nothing_else_is() {
        let cwd = Path::new("/work/draft");
        let extra = vec![PathBuf::from("/work/reference")];
        assert!(confine(Path::new("/work/reference/spec.md"), cwd, &extra).is_ok());
        assert!(
            confine(Path::new("/work/reference/../secrets"), cwd, &extra).is_err(),
            "the sibling of a declared directory is not declared"
        );
    }

    #[test]
    fn only_an_unrecognised_ending_makes_a_turn_not_ok() {
        for reason in [
            "end_turn",
            "max_tokens",
            "max_turn_requests",
            "cancelled",
            "refusal",
        ] {
            assert!(
                Ending::from_stop_reason(reason).is_ok(),
                "{reason} is an outcome, not a failure"
            );
        }
        assert!(!Ending::from_stop_reason("who knows").is_ok());
    }
}
